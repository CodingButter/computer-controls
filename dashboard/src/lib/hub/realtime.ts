/**
 * The realtime model and voice: which brain the orb opens a socket to, and
 * which mouth it wears.
 *
 * The hub's side of this shipped in #129 and nothing drew it, so the Models
 * page has been showing two disabled pickers. This is the slice that reads and
 * writes them.
 *
 * The catalogs are curated on the hub, not fetched from the provider, and this
 * slice does not second-guess that: a value the catalog does not name is still
 * a value a person chose, so it is shown as selected and carries the hub's
 * warning beside it rather than being quietly dropped. Discarding a chosen
 * value is the exact bug #129 exists to close, and doing it here in the page
 * would reopen it one layer up.
 */

import { fetchJson, type Fetched } from "./core";

export const REALTIME_SETTINGS_PATH = "/api/orb/realtime-settings";

/** A catalog entry and where it came from, so the page can say. */
export type CatalogEntry = { name: string; source: "curated" };

/**
 * What the hub holds and what it offers.
 *
 * `model` and `voice` are absent when nothing has been chosen: the orb then
 * runs on what this build pins, which is a different state from "chosen and
 * happens to match" and is worth showing as one.
 */
export type RealtimeSettings = {
  model?: string;
  voice?: string;
  models: readonly CatalogEntry[];
  voices: readonly CatalogEntry[];
  /** The hub's own sentences about values it does not recognise. */
  warnings: readonly string[];
};

function parseCatalog(value: unknown): readonly CatalogEntry[] {
  return (Array.isArray(value) ? value : [])
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .filter((row) => typeof row.name === "string")
    .map((row) => ({ name: row.name as string, source: "curated" }));
}

export function parseRealtimeSettings(body: unknown): RealtimeSettings {
  if (typeof body !== "object" || body === null || !("models" in body)) {
    throw new Error("not a realtime settings response");
  }
  const raw = body as Record<string, unknown>;
  return {
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(typeof raw.voice === "string" ? { voice: raw.voice } : {}),
    models: parseCatalog(raw.models),
    voices: parseCatalog(raw.voices),
    warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).filter(
      (line): line is string => typeof line === "string",
    ),
  };
}

export function getRealtimeSettings(): Promise<Fetched<RealtimeSettings>> {
  return fetchJson(REALTIME_SETTINGS_PATH, parseRealtimeSettings);
}

/**
 * Save a choice and return what the hub actually stored.
 *
 * A refused save throws rather than becoming a page state: it happened because
 * somebody picked something, and the reason belongs beside the picker. The
 * answer is the file's contents, not the request's — so the page can never show
 * a setting the hub did not keep.
 *
 * An empty string is the explicit "clear this" signal the route documents; it
 * is how a person goes back to what this build pins.
 */
export async function putRealtimeSettings(patch: {
  model?: string;
  voice?: string;
}): Promise<RealtimeSettings> {
  const response = await fetch(REALTIME_SETTINGS_PATH, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : "The hub refused the change.");
  }
  return parseRealtimeSettings(body);
}
