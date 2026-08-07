/**
 * What the Models page is allowed to know about packs, and the only place a
 * pack changes.
 *
 * Everything here is model names and provider names. No credential reaches this
 * file: it asks the credential store whether a provider is connected and is told
 * yes or no, which is the whole of what a page needs to decide between offering
 * a pack and explaining why it cannot. Nothing here speaks to the daemon socket,
 * and nothing an agent can call reaches these functions — a model pack is the
 * user's choice about their own machine, and widening it is not something the
 * thing being configured gets a vote on.
 */

import type { BrainTier } from "../../../clients/mastra-plugin/src/scope-brain.ts";
import type { CredentialStore } from "../auth/credentials.ts";
import {
  DECLARED_PACK,
  MODE_BRAINS,
  THINKING_MODE,
  TIERS,
  modelForTier,
  requireModelId,
  resolveModelPack,
  tierOverrides,
  type ModelPack,
} from "../model-pack.ts";
import { BUILT_IN_PACKS, listOfferings, providerOf, unselectableReason, type ProviderOffering } from "./catalogue.ts";
import type { CustomPack, PackStore } from "./store.ts";

/** A pack as the page shows it: what it is made of, and whether it can be picked. */
export interface PackView {
  id: string;
  name: string;
  source: "built-in" | "custom";
  models: Record<BrainTier, string>;
  active: boolean;
  selectable: boolean;
  /** Why it cannot be picked. Present exactly when `selectable` is false. */
  reason?: string;
}

export interface ModelPacksView {
  /** The pack answering turns right now, after the environment has had its say. */
  active: {
    id: string;
    name: string;
    models: Record<BrainTier, string>;
    /** The model a browser turn actually thinks with. */
    thinking: string;
  };
  /** The tier a browser turn runs at, so the page can mark the row that matters. */
  thinkingTier: BrainTier;
  tiers: readonly BrainTier[];
  /** Tiers this machine's environment pinned, mapped to the variable pinning them. */
  overrides: Partial<Record<BrainTier, string>>;
  packs: readonly PackView[];
  providers: readonly ProviderOffering[];
}

export type PackResult = { ok: true; view: ModelPacksView } | { ok: false; reason: string };

const NAME_LIMIT = 60;

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "pack";
}

export interface ModelPacksDeps {
  store: PackStore;
  credentials: CredentialStore;
  /** Injectable so a test can pin a machine's overrides without setting variables on the process. */
  env?: NodeJS.ProcessEnv;
}

export class ModelPacksService {
  private readonly store: PackStore;
  private readonly credentials: CredentialStore;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: ModelPacksDeps) {
    this.store = deps.store;
    this.credentials = deps.credentials;
    this.env = deps.env ?? process.env;
  }

  /**
   * The pack turns run on, environment applied.
   *
   * A chosen pack that no longer exists — deleted by hand out of the file, or
   * left behind by a build that stopped shipping it — resolves to the declared
   * pack, because a hub that refused to answer at all would be unusable for a
   * reason the person cannot see. A chosen pack whose provider is not connected
   * is *not* substituted: it stays, the page says why it cannot serve, and the
   * turn fails with the provider's own reason. A quiet swap to a model nobody
   * picked is the failure this repository exists to avoid.
   */
  activePack(): ModelPack {
    const document = this.store.read();
    const chosen = this.packById(document.activeId, document.custom) ?? DECLARED_PACK;
    return resolveModelPack(this.env, chosen);
  }

  view(): ModelPacksView {
    const document = this.store.read();
    const chosenId = this.packById(document.activeId, document.custom)?.id ?? DECLARED_PACK.id;
    const active = this.activePack();

    const packs: PackView[] = [];
    for (const pack of BUILT_IN_PACKS) {
      packs.push(this.toView(pack, pack.name, "built-in", chosenId));
    }
    for (const pack of document.custom) {
      packs.push(this.toView(pack, pack.name, "custom", chosenId));
    }

    return {
      active: {
        id: active.id,
        name: packs.find((pack) => pack.id === active.id)?.name ?? active.id,
        models: active.models,
        thinking: modelForTier(active, MODE_BRAINS[THINKING_MODE]),
      },
      thinkingTier: MODE_BRAINS[THINKING_MODE],
      tiers: TIERS,
      overrides: tierOverrides(this.env),
      packs,
      providers: listOfferings(this.credentials),
    };
  }

  /** Pick a pack. It answers the next turn; the one in flight keeps the model it started with. */
  setActive(id: string): PackResult {
    const document = this.store.read();
    const pack = this.packById(id, document.custom);
    if (!pack) return { ok: false, reason: `There is no pack called "${id}".` };

    const reason = unselectableReason(pack, this.credentials);
    if (reason) return { ok: false, reason };

    this.store.write({ custom: document.custom, activeId: pack.id });
    return { ok: true, view: this.view() };
  }

  /**
   * Make a pack.
   *
   * Every model is checked by the same function the boot check uses, so a pack
   * that would have stopped the hub at start-up is refused here instead, while
   * the person is still looking at the field they typed it into.
   */
  create(input: { name?: unknown; models?: unknown }): PackResult {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) return { ok: false, reason: "A pack needs a name." };
    if (name.length > NAME_LIMIT) {
      return { ok: false, reason: `A pack name has to be ${NAME_LIMIT} characters or fewer.` };
    }

    const supplied =
      typeof input.models === "object" && input.models !== null
        ? (input.models as Record<string, unknown>)
        : {};
    const models = {} as Record<BrainTier, string>;
    for (const tier of TIERS) {
      const value = supplied[tier];
      if (value !== undefined && typeof value !== "string") {
        return { ok: false, reason: `The model for the "${tier}" tier has to be a model id.` };
      }
      try {
        models[tier] = requireModelId(value as string | undefined, tier, `The pack "${name}"`);
      } catch (error) {
        return { ok: false, reason: (error as Error).message };
      }
      const provider = providerOf(models[tier]);
      if (!provider) {
        return { ok: false, reason: `"${models[tier]}" is not a "provider/model" id.` };
      }
    }

    const document = this.store.read();
    const taken = new Set([
      ...BUILT_IN_PACKS.map((pack) => pack.id),
      ...document.custom.map((pack) => pack.id),
    ]);
    let id = slugify(name);
    let suffix = 2;
    while (taken.has(id)) id = `${slugify(name)}-${suffix++}`;

    const pack: CustomPack = { id, name, models };
    this.store.write({ custom: [...document.custom, pack], activeId: document.activeId });
    return { ok: true, view: this.view() };
  }

  /**
   * Delete a pack a person made.
   *
   * A built-in is refused rather than hidden: this build ships them, and a page
   * that appeared to delete one would be lying at the next restart. Deleting the
   * pack currently answering turns hands the hub back to the declared pack,
   * because the alternative is a hub pointing at something that is gone.
   */
  remove(id: string): PackResult {
    if (BUILT_IN_PACKS.some((pack) => pack.id === id)) {
      return {
        ok: false,
        reason: `"${id}" ships with this build, so it cannot be deleted. Duplicate it to get a pack you own.`,
      };
    }

    const document = this.store.read();
    if (!document.custom.some((pack) => pack.id === id)) {
      return { ok: false, reason: `There is no pack called "${id}".` };
    }

    const custom = document.custom.filter((pack) => pack.id !== id);
    const activeId = document.activeId === id ? undefined : document.activeId;
    this.store.write({ custom, ...(activeId ? { activeId } : {}) });
    return { ok: true, view: this.view() };
  }

  private packById(
    id: string | undefined,
    custom: readonly CustomPack[],
  ): (ModelPack & { name?: string }) | undefined {
    if (!id) return undefined;
    return (
      BUILT_IN_PACKS.find((pack) => pack.id === id) ?? custom.find((pack) => pack.id === id)
    );
  }

  private toView(
    pack: ModelPack & { name?: string },
    name: string,
    source: "built-in" | "custom",
    chosenId: string,
  ): PackView {
    const reason = unselectableReason(pack, this.credentials);
    return {
      id: pack.id,
      name,
      source,
      models: pack.models,
      active: pack.id === chosenId,
      selectable: reason === undefined,
      ...(reason ? { reason } : {}),
    };
  }
}
