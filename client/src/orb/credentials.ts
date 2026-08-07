/**
 * The orb's credential, resolved the same way the voice lane resolves its own.
 *
 * The orb's mouth is provider-agnostic at the seam, but the credential it dials
 * with is provider-specific: Google's key files under `google`, OpenAI's under
 * `openai-codex`, and each mints from a different endpoint. This module picks
 * the provider (from a setting, or the first credentialed one) and resolves its
 * key, or says why there isn't one — in the same vocabulary the routes speak so
 * a page never has to translate.
 */

import {
  DEFAULT_REALTIME_PROVIDER,
  REALTIME_PROVIDERS,
  REALTIME_PROVIDER_IDS,
  hasRealtimeCredential,
  type RealtimeCredentialLookup,
  type RealtimeProviderId,
} from "./providers.ts";
import { isRefusal, type VoiceCredential, type VoiceRefusal } from "../voice/credentials.ts";

export { isRefusal } from "../voice/credentials.ts";
export type { VoiceCredential, VoiceRefusal } from "../voice/credentials.ts";

/**
 * Google credentials file under their own name.
 *
 * Unlike OpenAI — whose credentials the SDK gateway insists on finding under
 * `openai-codex` — there is no rename to honour here.
 */
export const GOOGLE_PROVIDER_ID = REALTIME_PROVIDERS["gemini-live"].authProviderId;

/**
 * Finds the credential a given provider's orb may use, or says why there
 * isn't one.
 *
 * A stored API key wins over an OAuth login: it is the one credential kind both
 * realtime endpoints are documented to accept. The OAuth branch goes through
 * `getApiKey` rather than reading `access` off the credential, so an expired
 * token is refreshed by whoever owns the store instead of by us.
 */
export async function resolveRealtimeCredential(
  store: RealtimeCredentialLookup,
  provider: RealtimeProviderId,
): Promise<VoiceCredential | VoiceRefusal> {
  const descriptor = REALTIME_PROVIDERS[provider];
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
      reason: `Your ${descriptor.name} sign-in could not be refreshed. Sign in again to turn the orb back on.`,
    };
  }
  return { kind: "chatgpt-oauth", key: refreshed, provider };
}

/**
 * Picks the mouth, then finds its key.
 *
 * The preference is a setting, so it is allowed to name a provider this machine
 * cannot currently serve — and that gets its own answer rather than a silent
 * fallback: a provider with no credential says so, by name. Falling back to a
 * provider the person did not choose would be the one unhelpful option — they
 * would get a voice, and no way to tell it was the wrong one.
 *
 * With no preference the first credentialed provider wins, which on a machine
 * that has only ever had a Google key is the behaviour that was already there.
 */
export async function resolveRealtimeProvider(
  store: RealtimeCredentialLookup,
  preference?: RealtimeProviderId,
): Promise<VoiceCredential | VoiceRefusal> {
  const chosen =
    preference ?? REALTIME_PROVIDER_IDS.find((provider) => hasRealtimeCredential(store, provider));

  // Nothing is connected at all. The default provider's wording is the right
  // one to lead with: it is the provider the orb shipped with.
  if (!chosen) return { reason: REALTIME_PROVIDERS[DEFAULT_REALTIME_PROVIDER].missingCredentialReason };

  return resolveRealtimeCredential(store, chosen);
}

/**
 * Resolve the credential the orb may use, from whichever provider is connected.
 *
 * The original entry point, kept for callers that do not carry a preference.
 * Picks the first credentialed provider — Gemini Live by default, OpenAI when
 * that is all the machine has.
 */
export async function resolveOrbCredential(
  store: RealtimeCredentialLookup,
): Promise<VoiceCredential | VoiceRefusal> {
  return resolveRealtimeProvider(store);
}

/** Whether the orb can run at all, phrased for a page that has to explain itself. */
export function orbAvailability(
  credential: VoiceCredential | VoiceRefusal,
): { enabled: true } | { enabled: false; reason: string } {
  return isRefusal(credential) ? { enabled: false, reason: credential.reason } : { enabled: true };
}
