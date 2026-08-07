import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The user's own wake word, written down beside placement.json.
 *
 * Enrollment asks the user to say "hey mastra" three times; each take becomes a
 * template — a compact, length-invariant description of how this person sounds
 * saying the phrase — and the set persists here. The factory fingerprint set
 * (synthetic voices, generated elsewhere) and the real MFCC/DTW matcher live in
 * separate work; this file holds only what this user recorded, which is what the
 * matcher will weigh above the factory set.
 *
 * The discipline is tray-state's, copied deliberately. Every failure is silent
 * and lands on the defaults: an absent file is a first run, a malformed one is a
 * file somebody edited by hand, and both answers are the same answer. Field by
 * field rather than all-or-nothing, so a file holding one good template and one
 * piece of noise keeps the good template — the user's surviving recording is not
 * forfeit because its neighbour got mangled. And a plain `writeFileSync` is
 * enough: the worst corruption case is "defaults", which is already the
 * absent-file answer.
 */

/** @typedef {{ id?: string, phrase: string, createdAt: string, frames: number[][], sampleRate: number, weight?: number }} WakeTemplate */
/** @typedef {{ templates: WakeTemplate[], enrolled: boolean }} WakeTemplates */

export const DEFAULT_WAKE_TEMPLATES = Object.freeze({ templates: [], enrolled: false });

/**
 * Read stored wake templates out of text, defaulting anything that is not one.
 *
 * Each template is validated on its own: a recognisable template survives a
 * malformed sibling. The whole file is only forfeit when there is nothing left
 * to recognise.
 *
 * @param {string} raw
 * @returns {WakeTemplates}
 */
export function decodeWakeTemplates(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_WAKE_TEMPLATES };
  }
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_WAKE_TEMPLATES };
  const templates = Array.isArray(parsed.templates) ? parsed.templates.filter(isValidTemplate) : [];
  return {
    templates,
    enrolled: typeof parsed.enrolled === "boolean" ? parsed.enrolled : templates.length > 0,
  };
}

/**
 * @param {unknown} entry
 * @returns {boolean}
 */
function isValidTemplate(entry) {
  if (!entry || typeof entry !== "object") return false;
  const t = /** @type {Record<string, unknown>} */ (entry);
  return (
    typeof t.phrase === "string" &&
    typeof t.createdAt === "string" &&
    Array.isArray(t.frames) &&
    t.frames.length > 0 &&
    t.frames.every(
      (frame) =>
        Array.isArray(frame) &&
        frame.length > 0 &&
        frame.every((f) => typeof f === "number" && Number.isFinite(f)),
    ) &&
    typeof t.sampleRate === "number" &&
    Number.isFinite(t.sampleRate)
  );
}

/**
 * @param {WakeTemplates} state
 * @returns {string}
 */
export function encodeWakeTemplates(state) {
  return JSON.stringify({
    templates: Array.isArray(state.templates) ? state.templates : [],
    enrolled: Boolean(state.enrolled),
  });
}

/**
 * @param {string} file
 * @returns {WakeTemplates}
 */
export function readWakeTemplates(file) {
  try {
    return decodeWakeTemplates(readFileSync(file, "utf8"));
  } catch {
    return { ...DEFAULT_WAKE_TEMPLATES };
  }
}

/**
 * @param {string} file
 * @param {WakeTemplates} state
 */
export function writeWakeTemplates(file, state) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, encodeWakeTemplates(state));
  } catch {
    // Wake templates that could not be written down are still templates for
    // this run; the next successful write carries them. Enrollment is not
    // blocked by a disk it cannot reach.
  }
}
