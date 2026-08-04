/**
 * Which mouths this hub knows how to wear.
 *
 * The voice provider is a person's choice, not a constant in a source file, and
 * this module is the one place that choice is described. Everything a provider
 * needs to be offered, credentialed, and built is stated once here: the name a
 * person reads, the key its credential is filed under, and the transport its
 * mouth speaks over.
 *
 * The transport is the part that is not cosmetic. A provider is not
 * interchangeable with another just because both extend `MastraVoice`: OpenAI's
 * speech endpoints answer one request with one audio stream, which is what the
 * voice routes serve, while Gemini Live holds a socket open and answers in
 * events — its `speak` returns nothing at all. Pretending those are the same
 * shape would produce a provider that mounts cleanly and then goes silent. So
 * the lane is carried, and a provider is only offered for the surface that can
 * actually drive it.
 */

import type { CredentialStore } from "@mastra/code-sdk/auth/types";

/** A voice provider as a person picks it. */
export type VoiceProviderId = "openai" | "gemini-live";

/**
 * How a provider's mouth is driven.
 *
 * `http`: one request, one answer — what `/listen` and `/speak` serve today.
 * `realtime`: a bidirectional socket, opened and held. The orb is what opens
 * one; until it exists there is no surface here that can.
 */
export type VoiceLane = "http" | "realtime";

export interface VoiceProviderDescriptor {
  readonly id: VoiceProviderId;
  /** What the settings page calls it. */
  readonly name: string;
  /**
   * The key its credential is filed under in `auth.json`. Not always `id` —
   * OpenAI files under `openai-codex`, the same rule `auth/providers.ts` states
   * for the model side.
   */
  readonly authProviderId: string;
  readonly lane: VoiceLane;
  /** Why voice is off when this provider has no credential, phrased for a person. */
  readonly missingCredentialReason: string;
}

export const VOICE_PROVIDERS: Readonly<Record<VoiceProviderId, VoiceProviderDescriptor>> = {
  openai: {
    id: "openai",
    name: "OpenAI",
    authProviderId: "openai-codex",
    lane: "http",
    missingCredentialReason:
      "Voice needs an OpenAI account. The chat brain does not — it keeps using " +
      "whatever model you signed in with. Sign in to OpenAI, or paste an OpenAI " +
      "API key, to turn voice on.",
  },
  "gemini-live": {
    id: "gemini-live",
    name: "Gemini Live",
    authProviderId: "google",
    lane: "realtime",
    missingCredentialReason:
      "Voice needs a Google account. Paste a Google API key to turn Gemini Live on.",
  },
};

export const VOICE_PROVIDER_IDS: readonly VoiceProviderId[] = ["openai", "gemini-live"];

/** Narrow an untrusted setting to a provider we actually support. */
export function parseVoiceProviderId(value: unknown): VoiceProviderId | undefined {
  return typeof value === "string" && (VOICE_PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as VoiceProviderId)
    : undefined;
}

/**
 * What the settings surface is told about a voice provider. Deliberately not a
 * credential — whether it can be picked, and what happens if it is.
 */
export interface VoiceProviderView {
  provider: VoiceProviderId;
  name: string;
  lane: VoiceLane;
  /** True when this provider can serve the listen/speak routes today. */
  usable: boolean;
  /** Present exactly when `usable` is false: why picking it would not give voice. */
  reason?: string;
}

/** The read surface this module needs from the credential store. */
export type VoiceCredentialLookup = Pick<
  CredentialStore,
  "get" | "getStoredApiKey" | "getApiKey"
>;

/**
 * Whether a credential for this provider exists at all.
 *
 * Presence, not validity: the same question `auth/credentials.ts` answers for
 * the model side, asked of either slot, because the gateway reads the main slot
 * first and falls back to the `apikey:` one.
 */
export function hasVoiceCredential(
  store: Pick<VoiceCredentialLookup, "get" | "getStoredApiKey">,
  provider: VoiceProviderId,
): boolean {
  const { authProviderId } = VOICE_PROVIDERS[provider];

  if ((store.getStoredApiKey(authProviderId)?.trim().length ?? 0) > 0) return true;

  const credential = store.get(authProviderId);
  if (!credential) return false;
  if (credential.type === "oauth") return true;
  return credential.key.trim().length > 0;
}

/**
 * The voice providers this machine can actually offer.
 *
 * No key, no offer. A provider whose credential is not in the store is not in
 * this list at all — not greyed out, not listed with a note. The settings
 * surface renders what it is given, so the rule lives here rather than in a
 * template that could forget it.
 */
export function listVoiceProviders(
  store: Pick<VoiceCredentialLookup, "get" | "getStoredApiKey">,
): VoiceProviderView[] {
  return VOICE_PROVIDER_IDS.filter((provider) => hasVoiceCredential(store, provider)).map(
    (provider) => {
      const descriptor = VOICE_PROVIDERS[provider];
      const usable = descriptor.lane === "http";
      return {
        provider,
        name: descriptor.name,
        lane: descriptor.lane,
        usable,
        ...(usable ? {} : { reason: realtimeLaneReason(descriptor) }),
      };
    },
  );
}

/**
 * Why a credentialed realtime provider still cannot speak.
 *
 * Not a failure — a surface that does not exist yet. Said in the same register
 * as the credential refusals so a person reading a disabled button learns the
 * same kind of thing from both.
 */
export function realtimeLaneReason(descriptor: VoiceProviderDescriptor): string {
  return (
    `${descriptor.name} talks over a live connection, which the voice button ` +
    `does not open. It becomes available with the orb.`
  );
}
