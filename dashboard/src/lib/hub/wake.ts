/**
 * /api/wake/templates — the voice print, read and written by the page that
 * records it.
 *
 * Enrolment lives here rather than in the widget because the widget is a
 * click-through orb with no keyboard: it can draw a face, not a form. The
 * dashboard has buttons, a microphone, and a person looking at it. The hub owns
 * the result so every listening surface compares against the same voice.
 *
 * What crosses this wire is features, never audio. The recording is made in the
 * browser, reduced to cepstral frames there, and the samples are dropped; no
 * request in this file could carry a recording even if something upstream
 * wanted it to.
 */

import { fetchJson, type Fetched } from "./core";

export const WAKE_TEMPLATES_API_PATH = "/api/wake/templates";

export type WakeTemplate = {
  id: string;
  phrase: string;
  createdAt: string;
  frames: number[][];
  sampleRate: number;
  weight?: number;
};

export type WakeTemplatesView = {
  phrase: string;
  enrolled: boolean;
  templates: WakeTemplate[];
};

function parseTemplate(body: unknown): WakeTemplate | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.frames) || typeof raw.sampleRate !== "number") return undefined;
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    phrase: typeof raw.phrase === "string" ? raw.phrase : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    frames: raw.frames as number[][],
    sampleRate: raw.sampleRate,
    ...(typeof raw.weight === "number" ? { weight: raw.weight } : {}),
  };
}

export function parseWakeTemplates(body: unknown): WakeTemplatesView {
  if (typeof body !== "object" || body === null) throw new Error("not a wake templates response");
  const raw = body as Record<string, unknown>;
  const templates = (Array.isArray(raw.templates) ? raw.templates : [])
    .map(parseTemplate)
    .filter((t): t is WakeTemplate => t !== undefined);
  return {
    phrase: typeof raw.phrase === "string" ? raw.phrase : "hey mastra",
    enrolled: templates.length > 0,
    templates,
  };
}

export function getWakeTemplates(): Promise<Fetched<WakeTemplatesView>> {
  return fetchJson(WAKE_TEMPLATES_API_PATH, parseWakeTemplates);
}

/**
 * Save an enrolment and return what the hub actually holds.
 *
 * A refusal throws with the hub's own sentence, the way autostart does: the
 * person pressed Save while standing at the microphone, and "nothing usable in
 * that body" is worth more to them than a generic failure.
 */
export async function putWakeTemplates(
  templates: readonly Omit<WakeTemplate, "id">[],
): Promise<WakeTemplatesView> {
  const response = await fetch(WAKE_TEMPLATES_API_PATH, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templates }),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string" ? body.error : "The hub refused to store the enrolment.",
    );
  }
  return parseWakeTemplates(body);
}
