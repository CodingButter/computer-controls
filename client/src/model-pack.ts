import { buildMode } from "@mastra/code-sdk/agents/modes/build";
import { fastMode } from "@mastra/code-sdk/agents/modes/explore";
import { planMode } from "@mastra/code-sdk/agents/modes/plan";
import type { AgentControllerMode } from "@mastra/core/agent-controller";

import type { BrainTier } from "../../plugin/src/scope-brain.ts";

/**
 * Which model holds the desktop.
 *
 * The coding runtime underneath will happily answer that question by itself:
 * it resolves a model from this machine's saved settings, and failing that from
 * whatever pack it shipped with. Both are values nobody here chose. This is the
 * same doctrine the voice lane already applies to its speaker — a default can
 * move in a patch release, and the product comes back thinking with a different
 * brain, which reads as something being wrong with the product rather than with
 * a file nobody in this repository wrote.
 *
 * So the hub declares. The pack below is keyed by the plugin's brain tiers
 * rather than by the runtime's mode names, because the tiers are the vocabulary
 * the desktop side already speaks: `scope-brain.ts` turns a grant's severity and
 * breadth into "minimal", "standard" or "heavy" and deliberately refuses to name
 * models, on the grounds that the mapping belongs to the client author. This
 * file is that client author's half of the bargain. Re-pointing a tier here
 * re-points everything that resolves against it, and the tier logic never moves.
 */

/** A named set of models, one per tier of thinking. */
export type ModelPack = {
  /** Names the choice, so health can say which pack answered rather than only what it resolved to. */
  id: string;
  models: Record<BrainTier, string>;
};

/**
 * The pack this hub runs, and the only place a model name is chosen.
 *
 * Which models these are is configuration, not architecture: swapping the three
 * strings is a supported edit, and nothing outside this record needs to know.
 */
export const DECLARED_PACK: ModelPack = {
  id: "computer-controls-anthropic",
  models: {
    minimal: "anthropic/claude-haiku-4-5",
    standard: "anthropic/claude-sonnet-4-6",
    heavy: "anthropic/claude-opus-4-6",
  },
};

/**
 * Models this product does not run, whatever the runtime offers.
 *
 * Named here because a banned id is exactly the kind of thing that comes back
 * in a later edit: the declaration is three strings, and the reason one of them
 * is not allowed lives outside this file. The check runs at boot on whatever
 * the pack resolved to, so an override cannot smuggle one in either.
 */
export const BANNED_MODEL_IDS: readonly string[] = ["anthropic/claude-fable-5"];

/** The environment variable that re-points each tier, for a machine that runs something else. */
export const TIER_ENV: Record<BrainTier, string> = {
  minimal: "COMCON_MODEL_MINIMAL",
  standard: "COMCON_MODEL_STANDARD",
  heavy: "COMCON_MODEL_HEAVY",
};

/** Every tier a pack must fill, in the order a person reads them. */
export const TIERS = Object.keys(TIER_ENV) as readonly BrainTier[];

/**
 * How much thinking each of the runtime's modes is worth.
 *
 * The hub's chat runs at `build`, so `standard` is the tier that actually holds
 * the desktop today. Plan reads and reasons without acting, which is where the
 * expensive brain earns its keep; fast is the cheap one, by definition.
 */
export const MODE_BRAINS = {
  build: "standard",
  plan: "heavy",
  fast: "minimal",
} as const satisfies Record<string, BrainTier>;

/** The mode a browser turn runs at, and so the model that answers a person. */
export const THINKING_MODE = "build";

/**
 * A model id is `provider/model`. Checking the shape is not an attempt to
 * validate the catalogue — the runtime does that at the turn, and knows far more
 * about it than this file does. It is here so that a blank or half-typed
 * override fails on the line that set it, rather than three layers down as an
 * "Unknown model" from a component that never saw the environment.
 */
export function requireModelId(value: string | undefined, tier: BrainTier, source: string): string {
  const id = value?.trim();
  if (!id) {
    throw new Error(
      `${source} must name a model for the "${tier}" tier. The hub declares its own models and will not fall back to the runtime's default.`,
    );
  }
  const [provider, ...rest] = id.split("/");
  if (!provider || rest.length !== 1 || !rest[0]) {
    throw new Error(
      `${source} must be a "provider/model" id, got "${id}" for the "${tier}" tier.`,
    );
  }
  if (BANNED_MODEL_IDS.includes(id)) {
    throw new Error(
      `${source} names "${id}" for the "${tier}" tier, which this product does not run.`,
    );
  }
  return id;
}

/**
 * The pack, after the environment has had its say.
 *
 * An override may re-point a tier; silence leaves the declared value standing.
 * What neither can do is produce a pack with a hole in it: an override that is
 * set but empty, or a declaration somebody edited into an unusable state, throws
 * here — at boot, in the open — instead of letting the turn quietly resolve to
 * whatever the runtime would have picked on its own.
 *
 * `base` exists because a person can now choose a pack from the Models page, and
 * a chosen pack has to pass through exactly this check rather than a lenient
 * copy of it. The environment still has the last word over a chosen pack: a
 * variable set on this machine is an operator pinning a tier, and a page that
 * silently unpinned it would be changing a decision it was never told about.
 * The page is told instead — see `tierOverrides`.
 */
export function resolveModelPack(
  env: NodeJS.ProcessEnv = process.env,
  base: ModelPack = DECLARED_PACK,
): ModelPack {
  const label =
    base.id === DECLARED_PACK.id ? `The declared pack "${base.id}"` : `The pack "${base.id}"`;
  const models = {} as Record<BrainTier, string>;
  for (const tier of TIERS) {
    const override = env[TIER_ENV[tier]];
    models[tier] =
      override === undefined
        ? requireModelId(base.models[tier], tier, label)
        : requireModelId(override, tier, TIER_ENV[tier]);
  }
  return { id: base.id, models };
}

/** The tiers this machine's environment has pinned, and the variable doing the pinning. */
export function tierOverrides(env: NodeJS.ProcessEnv = process.env): Partial<Record<BrainTier, string>> {
  const pinned: Partial<Record<BrainTier, string>> = {};
  for (const tier of TIERS) {
    if (env[TIER_ENV[tier]] !== undefined) pinned[tier] = TIER_ENV[tier];
  }
  return pinned;
}

/** The model a tier resolves to. The tier logic decides how much thinking; the pack decides with what. */
export function modelForTier(pack: ModelPack, tier: BrainTier): string {
  return pack.models[tier];
}

/**
 * The runtime's modes, each carrying the model this repository chose.
 *
 * Handed to the controller at construction so that a session's mode is not a
 * label over an inherited default. The modes themselves are the runtime's own —
 * instructions, tool allow-lists and the plan-to-build transition are its
 * business, and rewriting them here to change a model id would be a fork nobody
 * asked for.
 */
export function hubModes(pack: ModelPack): AgentControllerMode[] {
  return [
    { ...buildMode, defaultModelId: modelForTier(pack, MODE_BRAINS.build) },
    { ...planMode, defaultModelId: modelForTier(pack, MODE_BRAINS.plan) },
    { ...fastMode, defaultModelId: modelForTier(pack, MODE_BRAINS.fast) },
  ];
}
