/** The credential flows and the voice lanes — everything the Models page drives. */

import { fetchJson, type Fetched } from "./core";

/**
 * A model provider, how it signs in, and whether it currently is.
 *
 * Every field here is copied by name from the hub's answer. That is the
 * models page's half of the property the routes already keep: there is no
 * token in these responses, and there is no line here that would carry one
 * into the page if one appeared tomorrow.
 */
export type ProviderFlow = {
  provider: string;
  name: string;
  connected: boolean;
  /** How it came to be connected. Absent when it is not. */
  method?: "oauth" | "api-key";
  loginKind: "paste-code" | "device-code" | "api-key";
  /** ms epoch an OAuth token expires; absent for API keys, which do not. */
  expiresAt?: number;
};

/** A sign-in in progress: where to go, what to type, how long to wait. */
export type LoginFlow = {
  sessionId: string;
  provider: string;
  status: "pending" | "complete" | "failed";
  url?: string;
  userCode?: string;
  instructions?: string;
  nextPollMs?: number;
  error?: string;
};

/** A mouth this machine can wear, as the hub offers it. */
export type VoiceProvider = {
  provider: string;
  name: string;
  lane: "http" | "realtime";
  usable: boolean;
  reason?: string;
};

const AUTH_BASE = "/api/oauth";

function asLoginKind(value: unknown): ProviderFlow["loginKind"] {
  return value === "device-code" || value === "api-key" ? value : "paste-code";
}

export function parseFlows(body: unknown): readonly ProviderFlow[] {
  if (typeof body !== "object" || body === null || !("providers" in body)) {
    throw new Error("not a flows response");
  }
  const raw = (body as { providers: unknown }).providers;
  return (Array.isArray(raw) ? raw : [])
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .filter((row) => typeof row.provider === "string" && typeof row.name === "string")
    .map((row) => ({
      provider: row.provider as string,
      name: row.name as string,
      connected: row.connected === true,
      loginKind: asLoginKind(row.loginKind),
      ...(row.method === "oauth" || row.method === "api-key" ? { method: row.method } : {}),
      ...(typeof row.expiresAt === "number" ? { expiresAt: row.expiresAt } : {}),
    }));
}

export function parseLoginFlow(body: unknown): LoginFlow {
  if (typeof body !== "object" || body === null || !("sessionId" in body)) {
    throw new Error("not a login session response");
  }
  const raw = body as Record<string, unknown>;
  const status = raw.status === "complete" || raw.status === "failed" ? raw.status : "pending";
  return {
    sessionId: String(raw.sessionId),
    provider: typeof raw.provider === "string" ? raw.provider : "",
    status,
    ...(typeof raw.url === "string" ? { url: raw.url } : {}),
    ...(typeof raw.userCode === "string" ? { userCode: raw.userCode } : {}),
    ...(typeof raw.instructions === "string" ? { instructions: raw.instructions } : {}),
    ...(typeof raw.nextPollMs === "number" ? { nextPollMs: raw.nextPollMs } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
  };
}

export function parseVoiceProviders(body: unknown): readonly VoiceProvider[] {
  if (typeof body !== "object" || body === null || !("providers" in body)) {
    throw new Error("not a voice providers response");
  }
  const raw = (body as { providers: unknown }).providers;
  return (Array.isArray(raw) ? raw : [])
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .filter((row) => typeof row.provider === "string" && typeof row.name === "string")
    .map((row) => ({
      provider: row.provider as string,
      name: row.name as string,
      lane: row.lane === "realtime" ? "realtime" : "http",
      usable: row.usable === true,
      ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    }));
}

export function getFlows(): Promise<Fetched<readonly ProviderFlow[]>> {
  return fetchJson(`${AUTH_BASE}/flows`, parseFlows);
}

export function getVoiceProviders(): Promise<Fetched<readonly VoiceProvider[]>> {
  return fetchJson("/api/voice/providers", parseVoiceProviders);
}

/**
 * The sign-in calls, which throw rather than return a state.
 *
 * A refused sign-in is not a page state the way an unreachable hub is: it
 * happened because somebody pressed a button, and the reason belongs next to
 * that button. The hub phrases these refusals for a person, so they are shown
 * as sent.
 */
async function post(path: string, payload: unknown): Promise<unknown> {
  const response = await fetch(`${AUTH_BASE}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : "Request failed.");
  }
  return body;
}

export async function startLogin(provider: string): Promise<LoginFlow> {
  return parseLoginFlow(await post("/start", { provider }));
}

export async function pollLogin(sessionId: string): Promise<LoginFlow> {
  return parseLoginFlow(await post("/poll", { sessionId }));
}

export async function completeLogin(sessionId: string, code: string): Promise<LoginFlow> {
  return parseLoginFlow(await post("/complete", { sessionId, code }));
}

export async function saveApiKey(provider: string, key: string): Promise<void> {
  // The answer carries the provider's new connection state, which the page
  // re-reads from /flows anyway. Nothing here keeps the key.
  await post("/api-key", { provider, key });
}

export async function disconnectProvider(provider: string): Promise<void> {
  await post("/disconnect", { provider });
}
