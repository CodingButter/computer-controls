/**
 * The voice print, kept by the hub because more than one client listens.
 *
 * The wake phrase stopped being a word in a transcript and became a shape in
 * the audio, and that shape is a person's own voice saying "hey mastra". Every
 * surface with a microphone needs the same shape to compare against: the widget
 * on this desk, the dashboard page in a browser, a paired phone later. If each
 * of them stored its own copy, a person would enrol once per device and wonder
 * why the machine forgets them every time they open a new window.
 *
 * So the hub holds it. Enrolment happens on a page with real buttons, the
 * templates land here, and a client asks for them when its ears start.
 *
 * Two things this file is careful about. It stores features, never audio — the
 * frames are cepstral coefficients, from which no recording can be recovered,
 * and the recordings themselves never leave the page that made them. And a
 * malformed template is dropped on its own rather than forfeiting the file: one
 * bad take should cost a person that take, not their enrolment.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ENROLLED_WAKE_WEIGHT } from "../live/fingerprint.ts";
import FACTORY_BANK from "./factory-bank.json" with { type: "json" };

/** Beside the hub's own settings, not inside the agent runtime's. */
export const WAKE_TEMPLATES_FILE = "wake-templates.json";

/**
 * The phrase this product wakes on. Fixed, and stored with every template so a
 * bank recorded against an older phrase can be told apart from the current one.
 */
export const WAKE_PHRASE = "hey mastra";

/**
 * Bounds on what a client may hand us.
 *
 * Not tuning knobs — a template is roughly a hundred frames of thirteen
 * coefficients, so anything near these ceilings is a mistake or an attack, and
 * either way the hub should not hold it in memory.
 */
const MAX_TEMPLATES = 16;
const MAX_FRAMES = 4_000;
const MAX_FRAME_WIDTH = 64;

/** One recorded utterance, reduced to the arithmetic the gate compares against. */
export type WakeTemplate = {
  id: string;
  phrase: string;
  createdAt: string;
  /** Per-frame cepstral coefficients. Features, not audio. */
  frames: number[][];
  sampleRate: number;
  /** How much this template counts for. A person's own voice outranks the factory set. */
  weight?: number;
  /**
   * Who this shape came from. The gate does not read it — the gate reads the
   * weight — but everything else does: a page saying "three takes stored" means
   * three of yours, not three of yours and twenty-two strangers'.
   */
  source: "factory" | "enrolled";
};

/**
 * The shapes this product knows before it has met you: renderings of "hey
 * mastra" across eleven voices, built by scripts/generate-wake-defaults.mjs and
 * committed as data.
 *
 * They are a floor and a modest one. Measured, a stranger's voice against these
 * admits about a third of true takes before it starts admitting noise, which is
 * enough to answer the first "hey mastra" someone tries and not enough to live
 * on. Their real job is to get a person as far as the enrolment page, after
 * which their own takes outweigh all of this.
 */
export const FACTORY_TEMPLATES: readonly WakeTemplate[] = (
  FACTORY_BANK.templates as { id: string; frames: number[][]; sampleRate: number }[]
).map((raw) => ({
  id: raw.id,
  phrase: WAKE_PHRASE,
  createdAt: new Date(0).toISOString(),
  frames: raw.frames,
  sampleRate: raw.sampleRate,
  source: "factory" as const,
}));

/**
 * What the hub knows about waking, as a whole.
 *
 * `templates` is the whole bank a listening client should compare against —
 * the factory shapes and the owner's own, in one list, because a client that
 * had to assemble a bank from two endpoints is a client that can assemble it
 * wrongly. `enrolled` says whether any of them are the owner's, which is the
 * only part of this a person is ever asked about.
 */
export type WakeTemplateState = {
  phrase: string;
  enrolled: boolean;
  templates: WakeTemplate[];
};

/** Just the owner's own takes: what a page counts when it says "3 takes stored". */
export function enrolledTemplates(state: WakeTemplateState): WakeTemplate[] {
  return state.templates.filter((t) => t.source === "enrolled");
}

const EMPTY: WakeTemplateState = { phrase: WAKE_PHRASE, enrolled: false, templates: [] };

function isFrames(value: unknown): value is number[][] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FRAMES) return false;
  return value.every(
    (frame) =>
      Array.isArray(frame) &&
      frame.length > 0 &&
      frame.length <= MAX_FRAME_WIDTH &&
      frame.every((n) => typeof n === "number" && Number.isFinite(n)),
  );
}

/**
 * Narrow one untrusted entry, or say it is not a template.
 *
 * Missing identity and timestamp are filled rather than refused: they are the
 * hub's bookkeeping, and a client that omits them is being terse, not wrong.
 * The frames are the part nobody can invent, so that is the part we insist on.
 */
export function parseWakeTemplate(body: unknown): WakeTemplate | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const raw = body as Record<string, unknown>;
  if (!isFrames(raw.frames)) return undefined;
  if (typeof raw.sampleRate !== "number" || !Number.isFinite(raw.sampleRate) || raw.sampleRate <= 0)
    return undefined;

  // A client that hands back a template it was given keeps its provenance;
  // anything else arriving through this door is somebody's own recording. The
  // weight follows from that and is never taken from the body: a client cannot
  // promote itself above the owner by inventing a bigger number, nor demote
  // itself below the shipped shapes by omitting one.
  const source = raw.source === "factory" ? ("factory" as const) : ("enrolled" as const);

  return {
    source,
    id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : randomId(),
    phrase: typeof raw.phrase === "string" && raw.phrase.length > 0 ? raw.phrase : WAKE_PHRASE,
    createdAt:
      typeof raw.createdAt === "string" && raw.createdAt.length > 0
        ? raw.createdAt
        : new Date().toISOString(),
    frames: raw.frames,
    sampleRate: raw.sampleRate,
    ...(source === "enrolled" ? { weight: ENROLLED_WAKE_WEIGHT } : {}),
  };
}

/** Narrow a whole file or request body, keeping whatever is recognisable. */
export function parseWakeTemplateState(body: unknown): WakeTemplateState {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return EMPTY;
  const raw = body as Record<string, unknown>;
  const list = Array.isArray(raw.templates) ? raw.templates : [];
  const parsed = list
    .slice(0, MAX_TEMPLATES + FACTORY_TEMPLATES.length)
    .map(parseWakeTemplate)
    .filter((t): t is WakeTemplate => t !== undefined);
  // The ceiling is on what a client may make us hold. A client handing back
  // the bank it was just given is handing back mostly our own shapes, and
  // counting those against its allowance would silently drop the takes it
  // actually came to save.
  const own = parsed.filter((t) => t.source === "enrolled").slice(0, MAX_TEMPLATES);
  const templates = [...parsed.filter((t) => t.source === "factory"), ...own];
  return {
    phrase: typeof raw.phrase === "string" && raw.phrase.length > 0 ? raw.phrase : WAKE_PHRASE,
    // Enrolment is a fact about the owner having recorded something, not a flag
    // a client can assert, and not something the shipped bank can satisfy on
    // their behalf. Twenty-two strangers saying the phrase is not you.
    enrolled: own.length > 0,
    templates,
  };
}

/** The owner's takes over the factory floor, as one bank. */
export function withFactoryBank(state: WakeTemplateState): WakeTemplateState {
  const own = state.templates.filter((t) => t.source === "enrolled");
  return {
    phrase: state.phrase,
    enrolled: own.length > 0,
    templates: [...FACTORY_TEMPLATES, ...own],
  };
}

function randomId(): string {
  return `wake-${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16)}`;
}

/** The read/write surface the route needs. Structural, so a test can supply memory. */
export interface WakeTemplateStore {
  read(): WakeTemplateState;
  save(state: WakeTemplateState): WakeTemplateState;
}

export class FileWakeTemplateStore implements WakeTemplateStore {
  private readonly file: string;

  /** @param dir The hub's config directory — the same one the preferences live in. */
  constructor(dir: string) {
    this.file = path.join(dir, WAKE_TEMPLATES_FILE);
  }

  /**
   * The whole bank: the factory shapes always, the owner's own on top.
   *
   * The factory templates are never written to disk and never read from it.
   * They ship with the code, so a person who upgrades gets the newer bank
   * without re-enrolling, and a person who deletes their voice print is left
   * with a machine that still answers strangers rather than a deaf one.
   */
  read(): WakeTemplateState {
    return withFactoryBank(this.readEnrolled());
  }

  private readEnrolled(): WakeTemplateState {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      // Nobody has enrolled yet. That is a state, not a failure.
      return EMPTY;
    }
    try {
      return parseWakeTemplateState(JSON.parse(raw));
    } catch {
      // Unparseable is the one case worth keeping quiet about rather than
      // raising on: a corrupt voice print should leave a person un-enrolled and
      // able to enrol again, not leave the hub unable to boot.
      return EMPTY;
    }
  }

  save(state: WakeTemplateState): WakeTemplateState {
    // Only the owner's takes are persisted. Writing the factory bank into a
    // person's file would freeze today's shapes into their machine forever.
    const parsed = parseWakeTemplateState({
      ...state,
      templates: state.templates.filter((t) => t.source !== "factory"),
    });
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return withFactoryBank(parsed);
  }
}
