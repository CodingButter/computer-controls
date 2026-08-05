/**
 * /api/autostart — whether the widget starts when this person signs in.
 *
 * The hub answers from the desktop's own autostart entry, read from disk on
 * every ask, so this slice never caches an answer either: the toggle draws
 * what the desktop will actually do at the next login, not what a page
 * remembers asking for. Unsupported is a first-class state with the hub's own
 * sentence — the reason arm pairing and voice use — never a dead toggle.
 */

import { fetchJson, type Fetched } from "./core";

export const AUTOSTART_API_PATH = "/api/autostart";

export type AutostartView =
  | { supported: true; enabled: boolean; path: string }
  | { supported: false; reason: string };

export function parseAutostart(body: unknown): AutostartView {
  if (typeof body !== "object" || body === null || !("supported" in body)) {
    throw new Error("not an autostart response");
  }
  const raw = body as Record<string, unknown>;
  if (raw.supported === true) {
    if (typeof raw.path !== "string") throw new Error("not an autostart response");
    return { supported: true, enabled: raw.enabled === true, path: raw.path };
  }
  return {
    supported: false,
    reason:
      typeof raw.reason === "string" ? raw.reason : "Start on boot is not available on this hub.",
  };
}

export function getAutostart(): Promise<Fetched<AutostartView>> {
  return fetchJson(AUTOSTART_API_PATH, parseAutostart);
}

/**
 * Flip the entry and return what the hub actually holds. A refused change
 * throws with the hub's sentence verbatim: it happened because somebody
 * pressed the switch, and the reason belongs beside it. The answer is a fresh
 * read of the disk, not an echo of the request — the page can never show a
 * state the hub did not produce.
 */
export async function putAutostart(enabled: boolean): Promise<AutostartView> {
  const response = await fetch(AUTOSTART_API_PATH, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : "The hub refused the change.");
  }
  return parseAutostart(body);
}
