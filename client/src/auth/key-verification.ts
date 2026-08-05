/**
 * Asking a provider whether the key it was just given is any good.
 *
 * A stored credential is not a working one. A key can be revoked, be for the
 * wrong account, or belong to an organisation with no credit left — and in
 * every one of those cases the settings page, reading only the store, would say
 * "Connected" while every model call failed somewhere the person cannot see.
 * The only authority on whether a key works is the provider, so we ask it once,
 * at the moment the key is pasted, and repeat what it says.
 *
 * Three answers, not two. `unverified` is the important one: most providers in
 * the registry are OpenAI-shaped and answer `GET {url}/models`, but some have no
 * URL, some point at a local server, and some will answer an endpoint we did not
 * ask about. Claiming a key is good because a probe we could not run did not
 * fail would be the same lie in the other direction.
 */

import { safeReason } from "../safe-reason.ts";
import type { ProviderDescriptor } from "./providers.ts";

export type KeyVerification =
  | { status: "accepted" }
  | { status: "rejected"; reason: string }
  | { status: "unverified" };

export interface ApiKeyVerifier {
  verify(provider: ProviderDescriptor, key: string): Promise<KeyVerification>;
}

const VERIFY_TIMEOUT_MS = 5_000;

/** How much of a provider's error body we are willing to read before giving up. */
const MAX_REASON_BYTES = 2_048;

/**
 * Statuses that mean "this credential will not serve you".
 *
 * Wider than authentication on purpose: a key that authenticates but has no
 * credit (402) or is over its limit (429) is not a provider the agent can use,
 * and telling somebody they are connected while every request bounces is the
 * failure this whole file exists to prevent. Anything else — a 404 from a
 * provider that has no `models` endpoint, a 500 from one having a bad day — is
 * not evidence about the key.
 */
const REFUSAL_STATUSES = new Set([401, 402, 403, 429]);

/**
 * The probe URL, or nothing.
 *
 * Registry URLs are not all fetchable: a few are placeholders waiting on an
 * environment variable (`${NEON_AI_GATEWAY_BASE_URL}/v1`) and several point at
 * a server on the person's own machine. Refusing to build a URL from those is
 * how they end up `unverified` rather than falsely rejected.
 */
function probeUrl(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined || baseUrl.includes("${")) return undefined;
  if (!baseUrl.startsWith("https://")) return undefined;
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

/** Whatever the provider said, reduced to one line fit to show a human. */
async function readRefusalReason(response: Response, name: string): Promise<string> {
  const fallback = `${name} refused this key (HTTP ${response.status}).`;

  let body: string;
  try {
    body = (await response.text()).slice(0, MAX_REASON_BYTES);
  } catch {
    return fallback;
  }

  let stated = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const error = record["error"];
      const nested =
        typeof error === "object" && error !== null
          ? (error as Record<string, unknown>)["message"]
          : undefined;
      const candidate = nested ?? record["message"] ?? (typeof error === "string" ? error : undefined);
      if (typeof candidate === "string") stated = candidate;
    }
  } catch {
    // Not JSON. The raw text is still what the provider said.
  }

  // `safeReason` is the same limit the sign-in lane uses: first line, capped,
  // dropped entirely if it looks like it is carrying a credential. A provider
  // that echoes the key back in its error message does not get to put it on
  // the page.
  return safeReason(stated, fallback);
}

/**
 * The real verifier.
 *
 * `fetchImpl` is a parameter so the suite can answer as a provider would
 * without a network, which is the only way "a rejected key says why" is a test
 * rather than a hope.
 */
export function createApiKeyVerifier(fetchImpl: typeof fetch = fetch): ApiKeyVerifier {
  return {
    async verify(provider, key) {
      const url = probeUrl(provider.url);
      if (url === undefined) return { status: "unverified" };

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { [provider.apiKeyHeader ?? "Authorization"]: `Bearer ${key}` },
          signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        });
      } catch {
        // We never reached them. That says nothing about the key.
        return { status: "unverified" };
      }

      if (response.ok) return { status: "accepted" };
      if (!REFUSAL_STATUSES.has(response.status)) return { status: "unverified" };

      return { status: "rejected", reason: await readRefusalReason(response, provider.name) };
    },
  };
}
