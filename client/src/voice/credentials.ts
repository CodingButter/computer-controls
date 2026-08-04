import {
  VOICE_PROVIDERS,
  VOICE_PROVIDER_IDS,
  hasVoiceCredential,
  realtimeLaneReason,
  type VoiceCredentialLookup,
  type VoiceProviderId,
} from "./providers.ts";

/**
 * OpenAI credentials live under this id whichever way they arrived: the Codex
 * device flow writes here, and a pasted platform key is stored as this
 * provider's API key. One id, two shapes.
 */
export const OPENAI_PROVIDER_ID = VOICE_PROVIDERS.openai.authProviderId;

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
  /** Which mouth this key opens. Decides what gets built, not just how. */
  provider: VoiceProviderId;
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

/**
 * Finds the credential a given provider's voice may use, or says why there
 * isn't one.
 *
 * A stored API key wins over an OAuth login: it is the one credential kind
 * OpenAI's speech endpoints are documented to accept. The OAuth branch goes
 * through `getApiKey` rather than reading `access` off the credential, so an
 * expired token is refreshed by whoever owns the store instead of by us.
 */
export async function resolveVoiceCredential(
  store: VoiceCredentialLookup,
  provider: VoiceProviderId = "openai",
): Promise<VoiceCredential | VoiceRefusal> {
  const descriptor = VOICE_PROVIDERS[provider];
  const missing = { reason: descriptor.missingCredentialReason };

  const storedKey = store.getStoredApiKey(descriptor.authProviderId);
  if (storedKey) return { kind: "api-key", key: storedKey, provider };

  const credential = store.get(descriptor.authProviderId);
  if (!credential) return missing;

  if (credential.type === "api_key") {
    return credential.key ? { kind: "api-key", key: credential.key, provider } : missing;
  }

  const refreshed = await store.getApiKey(descriptor.authProviderId);
  if (!refreshed) {
    return {
      reason:
        `Your ${descriptor.name} sign-in could not be refreshed. Sign in again ` +
        `to turn voice back on.`,
    };
  }
  return { kind: "chatgpt-oauth", key: refreshed, provider };
}

/**
 * Picks the mouth, then finds its key.
 *
 * The preference is a setting, so it is allowed to name a provider this machine
 * cannot currently serve, and both ways that can happen get their own answer: a
 * provider with no credential says so, and a credentialed provider whose lane
 * has no surface yet says that instead. Falling back to a provider the person
 * did not choose would be the one unhelpful option — they would get a voice,
 * and no way to tell it was the wrong one.
 *
 * With no preference the first credentialed provider wins, which on a machine
 * that has only ever had an OpenAI key is the behaviour that was already there.
 */
export async function resolveVoiceProvider(
  store: VoiceCredentialLookup,
  preference?: VoiceProviderId,
): Promise<VoiceCredential | VoiceRefusal> {
  const chosen =
    preference ?? VOICE_PROVIDER_IDS.find((provider) => hasVoiceCredential(store, provider));

  // Nothing is connected at all. The OpenAI wording is the right one to lead
  // with: it is the provider that serves the button today.
  if (!chosen) return { reason: VOICE_PROVIDERS.openai.missingCredentialReason };

  const descriptor = VOICE_PROVIDERS[chosen];
  if (descriptor.lane !== "http" && hasVoiceCredential(store, chosen)) {
    return { reason: realtimeLaneReason(descriptor) };
  }

  return resolveVoiceCredential(store, chosen);
}
