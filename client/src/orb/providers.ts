/**
 * Which realtime providers the orb knows how to dial.
 *
 * The orb's mouth is transport-agnostic — the `RealtimeSession` seam above this
 * line does not care whether the bytes cross a Gemini WebSocket or an OpenAI
 * WebRTC peer connection — but a provider is not interchangeable just because
 * both fit the seam. Each files its credential under a different name, mints its
 * ephemeral secret from a different endpoint, and speaks a different session
 * vocabulary on the wire. So the provider is carried here, stated once, the same
 * way `voice/providers.ts` states it for the voice lane.
 *
 * The orb lane is realtime-only: both providers speak a live session. There is
 * no `lane` distinction the way the voice lane has one, because every provider
 * here is offered for the same surface.
 */

import type { CredentialStore } from "@mastra/code-sdk/auth/types";

/** A realtime provider as a person picks it. */
export type RealtimeProviderId = "gemini-live" | "openai";

export interface RealtimeProviderDescriptor {
  readonly id: RealtimeProviderId;
  /** What the settings page calls it. */
  readonly name: string;
  /**
   * The key its credential is filed under in `auth.json`. Google files under
   * its own name; OpenAI files under `openai-codex`, the same rule
   * `auth/providers.ts` and `voice/providers.ts` state.
   */
  readonly authProviderId: string;
  /** Why the orb is off when this provider has no credential, phrased for a person. */
  readonly missingCredentialReason: string;
}

export const REALTIME_PROVIDERS: Readonly<Record<RealtimeProviderId, RealtimeProviderDescriptor>> = {
  "gemini-live": {
    id: "gemini-live",
    name: "Gemini Live",
    authProviderId: "google",
    missingCredentialReason:
      "The orb needs a Google account. The chat brain does not — it keeps using " +
      "whatever model you signed in with, and typing still works. Paste a Google " +
      "API key, or sign in to Google, to turn the orb on.",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    authProviderId: "openai-codex",
    missingCredentialReason:
      "The orb needs an OpenAI account. The chat brain does not — it keeps using " +
      "whatever model you signed in with, and typing still works. Sign in to " +
      "OpenAI, or paste an OpenAI API key, to turn the orb on.",
  },
};

/**
 * Gemini Live is the default — the provider the orb shipped with. A machine
 * that has never chosen one and has both connected gets Gemini, which is the
 * behaviour that was already there.
 */
export const DEFAULT_REALTIME_PROVIDER: RealtimeProviderId = "gemini-live";

/**
 * Ordered so the default wins when more than one provider is credentialed and
 * nobody has chosen. Matches the order a person would read: the one that was
 * there first, then the one that arrived.
 */
export const REALTIME_PROVIDER_IDS: readonly RealtimeProviderId[] = ["gemini-live", "openai"];

/** Narrow an untrusted setting to a provider we actually support. */
export function parseRealtimeProviderId(value: unknown): RealtimeProviderId | undefined {
  return typeof value === "string" && (REALTIME_PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as RealtimeProviderId)
    : undefined;
}

/** The read surface this module needs from the credential store. */
export type RealtimeCredentialLookup = Pick<
  CredentialStore,
  "get" | "getStoredApiKey" | "getApiKey"
>;

/**
 * Whether a credential for this provider exists at all.
 *
 * Presence, not validity: the same question `voice/providers.ts` asks, and the
 * same shape `auth/credentials.ts` answers for the model side.
 */
export function hasRealtimeCredential(
  store: Pick<RealtimeCredentialLookup, "get" | "getStoredApiKey">,
  provider: RealtimeProviderId,
): boolean {
  const { authProviderId } = REALTIME_PROVIDERS[provider];

  if ((store.getStoredApiKey(authProviderId)?.trim().length ?? 0) > 0) return true;

  const credential = store.get(authProviderId);
  if (!credential) return false;
  if (credential.type === "oauth") return true;
  return credential.key.trim().length > 0;
}
