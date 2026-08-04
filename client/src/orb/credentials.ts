/**
 * The orb's credential, resolved the same way the voice lane resolves its own.
 *
 * Ruling 5 asks for exactly one thing: the Google key lands in the same
 * `AuthStorage` the provider sign-in surface already writes to, and no key means
 * no orb — said out loud, with the text chat still working. So this file is a
 * near-twin of `voice/credentials.ts` rather than a new mechanism, and the
 * shapes it returns are the same shapes, so the routes above can refuse in one
 * vocabulary.
 */

import type { CredentialStore } from "@mastra/code-sdk/auth/types";
import { isRefusal, type VoiceCredential, type VoiceRefusal } from "../voice/credentials.ts";

export { isRefusal } from "../voice/credentials.ts";
export type { VoiceCredential, VoiceRefusal } from "../voice/credentials.ts";

/**
 * Google credentials file under their own name.
 *
 * Unlike OpenAI — whose credentials the SDK gateway insists on finding under
 * `openai-codex` — there is no rename to honour here. It is named anyway, so
 * that if the gateway ever gains an opinion about Google there is one line to
 * change rather than a string spread across the lane.
 */
export const GOOGLE_PROVIDER_ID = "google";

const NO_GOOGLE_ACCOUNT =
  "The orb needs a Google account. The chat brain does not — it keeps using " +
  "whatever model you signed in with, and typing still works. Paste a Google " +
  "API key, or sign in to Google, to turn the orb on.";

/**
 * Find the credential the orb may use, or say why there isn't one.
 *
 * A stored API key wins over a login, for the same reason it does in the voice
 * lane: it is the credential kind the realtime endpoint is documented to accept,
 * and the proof already on file in `docs/proofs` is a reminder that an
 * authenticated token and a usable one are different things.
 */
export async function resolveOrbCredential(
  store: Pick<CredentialStore, "get" | "getStoredApiKey" | "getApiKey">,
): Promise<VoiceCredential | VoiceRefusal> {
  const storedKey = store.getStoredApiKey(GOOGLE_PROVIDER_ID);
  if (storedKey) return { kind: "api-key", key: storedKey, provider: "gemini-live" };

  const credential = store.get(GOOGLE_PROVIDER_ID);
  if (!credential) return { reason: NO_GOOGLE_ACCOUNT };

  if (credential.type === "api_key") {
    return credential.key ? { kind: "api-key", key: credential.key, provider: "gemini-live" } : { reason: NO_GOOGLE_ACCOUNT };
  }

  const refreshed = await store.getApiKey(GOOGLE_PROVIDER_ID);
  if (!refreshed) {
    return {
      reason: "Your Google sign-in could not be refreshed. Sign in again to turn the orb back on.",
    };
  }
  return { kind: "chatgpt-oauth", key: refreshed, provider: "gemini-live" };
}

/** Whether the orb can run at all, phrased for a page that has to explain itself. */
export function orbAvailability(
  credential: VoiceCredential | VoiceRefusal,
): { enabled: true } | { enabled: false; reason: string } {
  return isRefusal(credential) ? { enabled: false, reason: credential.reason } : { enabled: true };
}
