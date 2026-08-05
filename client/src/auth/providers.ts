/**
 * Every provider the model runtime can route to, and where their credentials
 * land.
 *
 * This list is not written here. It is `PROVIDER_REGISTRY` from
 * `@mastra/core/llm` — the same registry Mastra Code's own gateway spreads when
 * it decides which providers it can resolve a model for. Hand-writing three
 * entries meant the settings page could only ever offer three accounts, while
 * the runtime happily routed to any of the hundred-odd others as soon as a key
 * appeared in `auth.json` by some other route. A dashboard that cannot manage a
 * credential the runtime is actively using is telling half the truth, so the
 * catalogue is derived from the runtime's own answer instead.
 *
 * What stays hand-written is the part the registry does not know: which
 * providers this product can drive an OAuth flow for. `OAUTH_OVERRIDES` is that
 * knowledge and nothing else — everything it does not name is an API-key
 * provider, which is a complete and honest answer rather than a missing one.
 *
 * There is one further detail here that is not cosmetic. The name a person
 * picks in the UI ("OpenAI") is not the name their credential is filed under.
 * Mastra Code's gateway looks OpenAI credentials up as `openai-codex` — that is
 * what its own `getAuthProviderId` does, and what `getOpenAIApiKey` reads — so
 * anything we write under `openai` would be invisible to the model resolution
 * that has to find it. The mapping below is that same rule, stated once, so the
 * rest of this package never has to remember it.
 */

import { PROVIDER_REGISTRY } from "@mastra/core/llm";

/** A provider as a person picks it: an id from the runtime's own registry. */
export type ProviderId = string;

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
  /**
   * The environment variables model resolution reads a pasted key from.
   *
   * A list because the registry sometimes gives more than one — Google's key is
   * read as `GOOGLE_API_KEY` by the gateway and as
   * `GOOGLE_GENERATIVE_AI_API_KEY` by the AI SDK's own provider, and a key that
   * only satisfies one of them is a connection that works in half the product.
   */
  readonly apiKeyEnvVars: readonly string[];
  /** Where a person goes to read about, or obtain, a key. */
  readonly docUrl?: string;
  /** The provider's API base, when the registry knows one. */
  readonly url?: string;
  /** The header its key travels in, when it is not `Authorization`. */
  readonly apiKeyHeader?: string;
}

/**
 * The providers this product owns a login flow for.
 *
 * Deliberately short. Adding a provider here means owning an OAuth client for
 * it; leaving one out means the person pastes a key, which already works end to
 * end through the same store. The SDK ships flows for `github-copilot` and
 * `xai` too, but this package does not wire them, and a sign-in button that
 * cannot start anything is worse than an honest key field.
 */
const OAUTH_OVERRIDES: Readonly<
  Record<string, { authProviderId?: string; loginKind: LoginKind; apiKeyEnvVars?: string[] }>
> = {
  anthropic: { loginKind: "paste-code" },
  openai: { authProviderId: "openai-codex", loginKind: "device-code" },
  // Google is also the orb's credential. The AI SDK's Google provider reads
  // `GOOGLE_GENERATIVE_AI_API_KEY`, so that one is written first and the
  // registry's own `GOOGLE_API_KEY` follows it.
  google: {
    loginKind: "api-key",
    apiKeyEnvVars: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  },
};

/**
 * The order the settings page renders in: the providers with a sign-in flow
 * first, in the order they were named above, then everything else by name.
 * Ordering is decided here rather than in the page so that the route, the tests
 * and the browser all agree on what "the first provider" means.
 */
const FEATURED_ORDER: readonly string[] = ["anthropic", "openai", "google"];

function describeFromRegistry(id: string): ProviderDescriptor {
  const config = PROVIDER_REGISTRY[id as keyof typeof PROVIDER_REGISTRY];
  const override = OAUTH_OVERRIDES[id];
  const registryEnvVars = Array.isArray(config.apiKeyEnvVar)
    ? config.apiKeyEnvVar
    : [config.apiKeyEnvVar];

  const descriptor: ProviderDescriptor = {
    id,
    name: config.name,
    authProviderId: override?.authProviderId ?? id,
    loginKind: override?.loginKind ?? "api-key",
    apiKeyEnvVars: override?.apiKeyEnvVars ?? registryEnvVars.filter((name) => name.length > 0),
    ...(config.docUrl !== undefined ? { docUrl: config.docUrl } : {}),
    ...(config.url !== undefined ? { url: config.url } : {}),
    ...(config.apiKeyHeader !== undefined ? { apiKeyHeader: config.apiKeyHeader } : {}),
  };

  return descriptor;
}

function buildCatalogue(): ReadonlyMap<ProviderId, ProviderDescriptor> {
  const registryIds = Object.keys(PROVIDER_REGISTRY);
  const featured = FEATURED_ORDER.filter((id) => registryIds.includes(id));
  const rest = registryIds
    .filter((id) => !featured.includes(id))
    .sort((left, right) =>
      PROVIDER_REGISTRY[left as keyof typeof PROVIDER_REGISTRY].name.localeCompare(
        PROVIDER_REGISTRY[right as keyof typeof PROVIDER_REGISTRY].name,
      ),
    );

  return new Map([...featured, ...rest].map((id) => [id, describeFromRegistry(id)]));
}

export const PROVIDERS: ReadonlyMap<ProviderId, ProviderDescriptor> = buildCatalogue();

export const PROVIDER_IDS: readonly ProviderId[] = [...PROVIDERS.keys()];

/**
 * The descriptor for a provider we support.
 *
 * Throws on an id that is not in the catalogue, which is unreachable from a
 * request: everything arriving over HTTP passes {@link parseProviderId} first,
 * and that only ever returns an id this map has.
 */
export function describeProvider(provider: ProviderId): ProviderDescriptor {
  const descriptor = PROVIDERS.get(provider);
  if (!descriptor) throw new Error(`Unknown provider: ${provider}`);
  return descriptor;
}

/** Providers whose sign-in button drives an OAuth flow rather than a paste field. */
export function hasLoginFlow(provider: ProviderId): boolean {
  return describeProvider(provider).loginKind !== "api-key";
}

/**
 * The key a provider's credential is filed under.
 *
 * Mirrors `getAuthProviderId` in the SDK's gateway: `openai` stores as
 * `openai-codex`, everything else stores as itself.
 */
export function getAuthProviderId(provider: ProviderId): string {
  return describeProvider(provider).authProviderId;
}

/** Narrow an untrusted request field to a provider we actually support. */
export function parseProviderId(value: unknown): ProviderId | undefined {
  return typeof value === "string" && PROVIDERS.has(value) ? value : undefined;
}
