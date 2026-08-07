/**
 * Realtime model and voice settings, persisted on the hub's own disk.
 *
 * The realtime model and the speaking voice were once pinned in source
 * (`LIVE_MODEL` in live.ts). When that model was retired upstream the orb went
 * mute with no code change — which is the bug #129 exists to close. These two
 * settings live where the hub reads them at boot, so a person can pick a model
 * their provider still offers without a deploy (#129).
 *
 * The store is the same `settings.json` the code-sdk writes model-pack choices
 * into (hub.ts). Read-modify-write preserves every key that is not ours: the
 * two additions are `realtimeModel` and `realtimeVoice`, and that is all this
 * module ever touches.
 *
 * The catalog is a curated named set rather than a live `models.list` query.
 * Freshness is traded for no network dependency: a settings page that needs the
 * network to render cannot be opened when the network is the thing that is
 * broken. An unknown-but-typed value is saved and applied with a warning
 * instead of a refusal — the same bug class that caused #129, structurally
 * eliminated by never silently discarding a value the person chose.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Hono } from "hono";

import { REALTIME_PROVIDER_IDS, parseRealtimeProviderId } from "./providers.ts";

export const REALTIME_SETTINGS_PATH = "/api/orb/realtime-settings";

/** Provenance tag so the UI can say where a catalog entry came from. */
export type CatalogEntry = { name: string; source: "curated" };

/**
 * The models known to speak the Gemini Live protocol.
 *
 * Curated, not fetched: a settings page that needs the network to render is a
 * settings page that cannot be opened when the network is the problem. An
 * unknown value a person pastes is still saved — it is just not in this list.
 *
 * Every name here was read back from the provider's own `models.list`, filtered
 * to those declaring `bidiGenerateContent`. The list shipped with a name that
 * had never been checked against anything, and a curated list carrying a model
 * the provider does not have is worse than no list: it is the settings page
 * handing a person a broken choice with the authority of a menu.
 */
export const REALTIME_MODELS: readonly CatalogEntry[] = Object.freeze([
  { name: "gemini-3.1-flash-live-preview", source: "curated" },
  { name: "gemini-2.5-flash-native-audio-latest", source: "curated" },
  { name: "gemini-2.5-flash-native-audio-preview-12-2025", source: "curated" },
]);

/**
 * The prebuilt voices the Gemini Live setup frame accepts.
 *
 * `LIVE_VOICE` is what speaks when none is chosen — pinned in source precisely
 * so the provider's own default cannot move underneath a running product.
 * Picking one here overrides that pin for the next conversation.
 */
export const REALTIME_VOICES: readonly CatalogEntry[] = Object.freeze([
  { name: "Puck", source: "curated" },
  { name: "Charon", source: "curated" },
  { name: "Kore", source: "curated" },
  { name: "Fenrir", source: "curated" },
  { name: "Aoede", source: "curated" },
  { name: "Leda", source: "curated" },
  { name: "Orus", source: "curated" },
  { name: "Zap", source: "curated" },
]);

export type RealtimeSettings = {
  realtimeModel?: string;
  realtimeVoice?: string;
  realtimeProvider?: string;
};

/**
 * What the settings route returns: the current values, the catalogs to populate
 * pickers with, and warnings for anything saved that the catalog does not name.
 */
export type RealtimeSettingsView = {
  model: string | undefined;
  voice: string | undefined;
  provider: string | undefined;
  models: readonly CatalogEntry[];
  voices: readonly CatalogEntry[];
  providers: readonly string[];
  warnings: string[];
};

/** Keys this module owns in the shared settings file. */
const MODEL_KEY = "realtimeModel";
const VOICE_KEY = "realtimeVoice";
const PROVIDER_KEY = "realtimeProvider";

/** Read only the two keys this module owns from the shared settings file. */
export async function readRealtimeSettings(settingsPath: string): Promise<RealtimeSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    const model = typeof raw[MODEL_KEY] === "string" ? (raw[MODEL_KEY] as string) : undefined;
    const voice = typeof raw[VOICE_KEY] === "string" ? (raw[VOICE_KEY] as string) : undefined;
    const provider = typeof raw[PROVIDER_KEY] === "string" ? (raw[PROVIDER_KEY] as string) : undefined;
    return {
      ...(model !== undefined ? { realtimeModel: model } : {}),
      ...(voice !== undefined ? { realtimeVoice: voice } : {}),
      ...(provider !== undefined ? { realtimeProvider: provider } : {}),
    };
  } catch {
    // No file yet, or corrupt JSON — nothing has been chosen.
    return {};
  }
}

/**
 * Patch the two realtime keys into the shared settings file, preserving every
 * other key. An empty string clears the setting; `undefined` leaves it alone.
 */
export async function writeRealtimeSettings(
  settingsPath: string,
  patch: { model?: string; voice?: string; provider?: string },
): Promise<void> {
  // Read-modify-write: never truncate the file's other keys. The code-sdk owns
  // this file too, and stamping over its keys would silently change behaviour.
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    // No file yet — start from an empty object and create it below.
  }

  if (patch.model !== undefined) {
    if (patch.model === "") delete existing[MODEL_KEY];
    else existing[MODEL_KEY] = patch.model;
  }
  if (patch.voice !== undefined) {
    if (patch.voice === "") delete existing[VOICE_KEY];
    else existing[VOICE_KEY] = patch.voice;
  }
  if (patch.provider !== undefined) {
    if (patch.provider === "") delete existing[PROVIDER_KEY];
    else existing[PROVIDER_KEY] = patch.provider;
  }

  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(existing, null, 2), "utf8");
}

function isKnown(value: string | undefined, catalog: readonly CatalogEntry[]): boolean {
  return value === undefined || catalog.some((entry) => entry.name === value);
}

function warningFor(kind: string, value: string): string {
  return `"${value}" is not in the known ${kind} list. It has been saved and will be sent to the provider as-is — if the provider does not recognise it, the orb will say so.`;
}

/** The answer both routes give: current values, catalogs, and any warnings. */
async function viewOf(settingsPath: string): Promise<RealtimeSettingsView> {
  const settings = await readRealtimeSettings(settingsPath);
  const warnings: string[] = [];
  if (!isKnown(settings.realtimeModel, REALTIME_MODELS)) {
    warnings.push(warningFor("model", settings.realtimeModel!));
  }
  if (!isKnown(settings.realtimeVoice, REALTIME_VOICES)) {
    warnings.push(warningFor("voice", settings.realtimeVoice!));
  }
  // A provider the registry does not recognise is saved — not silently
  // discarded — but warned, the same way an unknown model is. A typo does not
  // turn the orb off; it gets a sentence that names it.
  if (settings.realtimeProvider !== undefined && parseRealtimeProviderId(settings.realtimeProvider) === undefined) {
    warnings.push(warningFor("provider", settings.realtimeProvider));
  }
  return {
    model: settings.realtimeModel,
    voice: settings.realtimeVoice,
    provider: settings.realtimeProvider,
    models: REALTIME_MODELS,
    voices: REALTIME_VOICES,
    providers: [...REALTIME_PROVIDER_IDS],
    warnings,
  };
}

/**
 * Build the GET/PUT settings Hono app. Mounted through the orb app so the route
 * works even when the orb itself is refused — the settings are machine facts,
 * not session state, and a person can pick a model before the orb can connect.
 */
export function buildRealtimeSettingsApp(settingsPath: string): Hono {
  const app = new Hono();

  app.get(REALTIME_SETTINGS_PATH, async (c) => c.json(await viewOf(settingsPath)));

  app.put(REALTIME_SETTINGS_PATH, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const patch = body as { model?: unknown; voice?: unknown; provider?: unknown } | undefined;

    // At least one field must be present; all, when present, must be strings.
    // An empty string is the explicit "clear this" signal.
    if (
      patch === undefined ||
      (patch.model === undefined && patch.voice === undefined && patch.provider === undefined)
    ) {
      return c.json({ error: "Expected { model?, voice?, provider? } with at least one field." }, 400);
    }
    if (patch.model !== undefined && typeof patch.model !== "string") {
      return c.json({ error: "model must be a string (or empty to clear)." }, 400);
    }
    if (patch.voice !== undefined && typeof patch.voice !== "string") {
      return c.json({ error: "voice must be a string (or empty to clear)." }, 400);
    }
    if (patch.provider !== undefined && typeof patch.provider !== "string") {
      return c.json({ error: "provider must be a string (or empty to clear)." }, 400);
    }

    await writeRealtimeSettings(settingsPath, {
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.voice !== undefined ? { voice: patch.voice } : {}),
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
    });

    // Answer with what was actually stored, so the UI never shows a value the
    // file does not hold.
    return c.json(await viewOf(settingsPath));
  });

  return app;
}
