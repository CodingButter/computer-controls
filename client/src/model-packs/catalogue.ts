/**
 * What a pack may be made of: the packs this build ships, and the models the
 * runtime can actually route to on this machine.
 *
 * The offerings are read from the runtime's own provider registry rather than
 * typed out here, for the reason `../auth/providers.ts` gives about the sign-in
 * catalogue: a list written by hand goes stale the first time the runtime learns
 * a model this file has never heard of, and a page offering last year's
 * catalogue is a page that lies quietly.
 *
 * Whether a provider is *connected* is a separate question, and it is asked of
 * the credential store — the same store the sign-in surface writes. A pack whose
 * models come from an account this machine does not hold is still shown, with
 * the reason it cannot be picked. No key, no offer; and never a pack that looks
 * selectable and fails at the turn instead.
 */

import { PROVIDER_REGISTRY } from "@mastra/core/llm";

import type { CredentialStore } from "../auth/credentials.ts";
import { PROVIDERS } from "../auth/providers.ts";
import { BANNED_MODEL_IDS, DECLARED_PACK, TIERS, type ModelPack } from "../model-pack.ts";

/** A pack this build ships. Not editable — duplicating one is how you get a starting point. */
export interface BuiltInPack extends ModelPack {
  name: string;
}

/**
 * The packs a person can pick without building one.
 *
 * The declared pack leads because it is the one this hub boots with — see
 * ../model-pack.ts for why this repository names its own models at all. The
 * other two exist so that "switch the brain" is a real choice on a machine
 * signed in to a different account, and so that a machine signed in to none of
 * them can see what it is missing rather than an empty list.
 */
export const BUILT_IN_PACKS: readonly BuiltInPack[] = [
  { ...DECLARED_PACK, name: "Anthropic (this build)" },
  {
    id: "computer-controls-openai",
    name: "OpenAI",
    models: {
      minimal: "openai/gpt-5.4-mini",
      standard: "openai/gpt-5.4",
      heavy: "openai/gpt-5.4-pro",
    },
  },
  {
    id: "computer-controls-google",
    name: "Google",
    models: {
      minimal: "google/gemini-3.5-flash-lite",
      standard: "google/gemini-3.5-flash",
      heavy: "google/gemini-3.1-pro-preview",
    },
  },
];

/** The provider half of a `provider/model` id, or undefined if it is not one. */
export function providerOf(modelId: string): string | undefined {
  const [provider, ...rest] = modelId.split("/");
  return provider && rest.length === 1 && rest[0] ? provider : undefined;
}

/** One provider's catalogue, and whether this machine can reach it. */
export interface ProviderOffering {
  provider: string;
  name: string;
  connected: boolean;
  /** Every model id the runtime could route to this provider, `provider/model`. */
  models: readonly string[];
}

/**
 * Every provider the runtime knows, each with the models it offers and whether
 * an account backs it.
 *
 * Deprecated models are dropped because the registry itself says they are, and
 * banned ones because this product does not run them — the same list the boot
 * check enforces, so the page cannot offer a model the hub would refuse.
 */
export function listOfferings(credentials: CredentialStore): readonly ProviderOffering[] {
  const offerings: ProviderOffering[] = [];
  for (const [provider, descriptor] of PROVIDERS) {
    const entry = PROVIDER_REGISTRY[provider as keyof typeof PROVIDER_REGISTRY] as
      | { models?: readonly string[]; deprecatedModels?: readonly string[] }
      | undefined;
    const deprecated = new Set(entry?.deprecatedModels ?? []);
    const models = (entry?.models ?? [])
      .filter((model) => !deprecated.has(model))
      .map((model) => `${provider}/${model}`)
      .filter((id) => !BANNED_MODEL_IDS.includes(id));
    if (models.length === 0) continue;
    offerings.push({
      provider,
      name: descriptor.name,
      connected: credentials.status(provider).connected,
      models,
    });
  }
  return offerings;
}

/** Why a pack cannot be selected right now, or undefined when it can. */
export function unselectableReason(
  pack: ModelPack,
  credentials: CredentialStore,
): string | undefined {
  const missing = new Map<string, string>();
  for (const tier of TIERS) {
    const modelId = pack.models[tier];
    const provider = providerOf(modelId);
    if (!provider) return `"${modelId}" is not a "provider/model" id.`;
    const descriptor = PROVIDERS.get(provider);
    if (!descriptor) {
      return `This hub's runtime has no provider called "${provider}", so "${modelId}" cannot be reached.`;
    }
    if (!credentials.status(provider).connected) missing.set(provider, descriptor.name);
  }

  if (missing.size === 0) return undefined;
  const names = [...missing.values()];
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `No ${list} account is connected on this machine, so a turn on this pack would fail. Connect ${
    names.length === 1 ? "it" : "them"
  } above and this pack becomes selectable.`;
}
