/**
 * The two accounts a person can sign in with, and where their credentials land.
 *
 * There is one detail here that is not cosmetic. The name a person picks in the
 * UI ("OpenAI") is not the name their credential is filed under. Mastra Code's
 * gateway looks OpenAI credentials up as `openai-codex` — that is what its own
 * `getAuthProviderId` does, and what `getOpenAIApiKey` reads — so anything we
 * write under `openai` would be invisible to the model resolution that has to
 * find it. The mapping below is that same rule, stated once, so the rest of
 * this package never has to remember it.
 */

/** A provider as a person picks it. */
export type ProviderId = "anthropic" | "openai" | "google";

/**
 * How a provider's OAuth login is driven.
 *
 * `paste-code`: we hand out a URL, the human comes back with a code.
 * `device-code`: we hand out a URL and a short code, then poll until approved.
 * `api-key`: there is no OAuth flow to drive; the person pastes a key.
 */
export type LoginKind = "paste-code" | "device-code" | "api-key";

export interface ProviderDescriptor {
  readonly id: ProviderId;
  /** What the settings page calls it. */
  readonly name: string;
  /** The key its credential is filed under in `auth.json`. Not always `id`. */
  readonly authProviderId: string;
  readonly loginKind: LoginKind;
  /** The environment variable model resolution reads a pasted key from. */
  readonly apiKeyEnvVar: string;
}

export const PROVIDERS: Readonly<Record<ProviderId, ProviderDescriptor>> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    authProviderId: "anthropic",
    loginKind: "paste-code",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    authProviderId: "openai-codex",
    loginKind: "device-code",
    apiKeyEnvVar: "OPENAI_API_KEY",
  },
  // Google is the orb's credential, and it arrives by paste only. The SDK ships
  // no Google login flow to drive, and inventing one here would mean owning an
  // OAuth client this project does not have — whereas the API-key path already
  // works end to end through the same store. `loginKind: "api-key"` says that
  // plainly rather than leaving a start button that cannot start anything.
  google: {
    id: "google",
    name: "Google",
    authProviderId: "google",
    loginKind: "api-key",
    apiKeyEnvVar: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
};

export const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "openai", "google"];

/** Providers whose sign-in button drives an OAuth flow rather than a paste field. */
export function hasLoginFlow(provider: ProviderId): boolean {
  return PROVIDERS[provider].loginKind !== "api-key";
}

/**
 * The key a provider's credential is filed under.
 *
 * Mirrors `getAuthProviderId` in the SDK's gateway: `openai` stores as
 * `openai-codex`, everything else stores as itself.
 */
export function getAuthProviderId(provider: ProviderId): string {
  return PROVIDERS[provider].authProviderId;
}

/** Narrow an untrusted request field to a provider we actually support. */
export function parseProviderId(value: unknown): ProviderId | undefined {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as ProviderId)
    : undefined;
}
