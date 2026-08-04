import type { CredentialStore } from "@mastra/code-sdk/auth/types";

/**
 * OpenAI credentials live under this id whichever way they arrived: the Codex
 * device flow writes here, and a pasted platform key is stored as this
 * provider's API key. One id, two shapes.
 */
export const OPENAI_PROVIDER_ID = "openai-codex";

/**
 * Which kind of secret the voice lane got. The distinction is carried rather
 * than flattened because it is not yet settled that a ChatGPT-plan token is
 * accepted by OpenAI's speech endpoints at all — see
 * docs/proofs/which-credential-the-voice-lane-accepts.md. If it turns out it is
 * not, this is the field that decides whether to refuse up front.
 */
export type VoiceCredentialKind = "api-key" | "chatgpt-oauth";

export type VoiceCredential = {
  kind: VoiceCredentialKind;
  key: string;
};

/**
 * Why the voice lane is closed, phrased for a person reading a disabled button
 * rather than for a log.
 */
export type VoiceRefusal = {
  reason: string;
};

export function isRefusal(
  resolved: VoiceCredential | VoiceRefusal,
): resolved is VoiceRefusal {
  return "reason" in resolved;
}

const NO_OPENAI_ACCOUNT =
  "Voice needs an OpenAI account. The chat brain does not — it keeps using " +
  "whatever model you signed in with. Sign in to OpenAI, or paste an OpenAI " +
  "API key, to turn voice on.";

/**
 * Finds the credential the voice lane may use, or says why there isn't one.
 *
 * A stored API key wins over an OAuth login: it is the one credential kind
 * OpenAI's speech endpoints are documented to accept. The OAuth branch goes
 * through `getApiKey` rather than reading `access` off the credential, so an
 * expired token is refreshed by whoever owns the store instead of by us.
 */
export async function resolveVoiceCredential(
  store: Pick<CredentialStore, "get" | "getStoredApiKey" | "getApiKey">,
): Promise<VoiceCredential | VoiceRefusal> {
  const storedKey = store.getStoredApiKey(OPENAI_PROVIDER_ID);
  if (storedKey) return { kind: "api-key", key: storedKey };

  const credential = store.get(OPENAI_PROVIDER_ID);
  if (!credential) return { reason: NO_OPENAI_ACCOUNT };

  if (credential.type === "api_key") {
    return credential.key
      ? { kind: "api-key", key: credential.key }
      : { reason: NO_OPENAI_ACCOUNT };
  }

  const refreshed = await store.getApiKey(OPENAI_PROVIDER_ID);
  if (!refreshed) {
    return {
      reason:
        "Your OpenAI sign-in could not be refreshed. Sign in again to turn " +
        "voice back on.",
    };
  }
  return { kind: "chatgpt-oauth", key: refreshed };
}
