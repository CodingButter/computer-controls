/** /api/model-packs — which pack thinks, which packs exist, and what a new one may be made of. */

/** A pack as the page shows it: what it is made of, and whether it can be picked. */
export type PackRow = {
  id: string;
  name: string;
  source: "built-in" | "custom";
  models: Record<string, string>;
  active: boolean;
  selectable: boolean;
  /** Why it cannot be picked — present exactly when `selectable` is false. */
  reason?: string;
};

/** One provider's catalogue, and whether an account on this machine backs it. */
export type PackProvider = {
  provider: string;
  name: string;
  connected: boolean;
  models: readonly string[];
};

export type ModelPacksView = {
  active: { id: string; name: string; models: Record<string, string>; thinking: string };
  /** The tier a browser turn runs at, so the page can mark the row that answers a person. */
  thinkingTier: string;
  tiers: readonly string[];
  /** Tiers this machine's environment pinned, mapped to the variable pinning them. */
  overrides: Record<string, string>;
  packs: readonly PackRow[];
  providers: readonly PackProvider[];
};

/**
 * Packs fail a third way health cannot: the hub answers, and the answer is no.
 * A pack whose provider has no key, a name already taken, a file the person
 * hand-edited into unreadable shape — all of them come back as a reason, and
 * the reason is the point. Showing "unreachable" instead would blame the wrong
 * thing and hide the one sentence that says what to do.
 */
export type ModelPacksFetch =
  | { kind: "ok"; data: ModelPacksView }
  | { kind: "unreachable"; detail: string }
  | { kind: "refused"; detail: string };

function asRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, model] of Object.entries(value as Record<string, unknown>)) {
    if (typeof model === "string") out[key] = model;
  }
  return out;
}

function asModelIds(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export function parseModelPacks(body: unknown): ModelPacksView {
  if (typeof body !== "object" || body === null || !("packs" in body)) {
    throw new Error("not a model-packs response");
  }
  const raw = body as Record<string, unknown>;
  const active =
    typeof raw.active === "object" && raw.active !== null
      ? (raw.active as Record<string, unknown>)
      : {};

  return {
    active: {
      id: typeof active.id === "string" ? active.id : "",
      name: typeof active.name === "string" ? active.name : "",
      models: asRecord(active.models),
      thinking: typeof active.thinking === "string" ? active.thinking : "",
    },
    thinkingTier: typeof raw.thinkingTier === "string" ? raw.thinkingTier : "",
    tiers: asModelIds(raw.tiers),
    overrides: asRecord(raw.overrides),
    packs: (Array.isArray(raw.packs) ? raw.packs : [])
      .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
      .filter((row) => typeof row.id === "string")
      .map((row) => ({
        id: row.id as string,
        name: typeof row.name === "string" ? row.name : (row.id as string),
        source: row.source === "custom" ? "custom" : "built-in",
        models: asRecord(row.models),
        active: row.active === true,
        selectable: row.selectable === true,
        ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
      })),
    providers: (Array.isArray(raw.providers) ? raw.providers : [])
      .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
      .filter((row) => typeof row.provider === "string")
      .map((row) => ({
        provider: row.provider as string,
        name: typeof row.name === "string" ? row.name : (row.provider as string),
        connected: row.connected === true,
        models: asModelIds(row.models),
      })),
  };
}

async function fetchPacks(path: string, init?: RequestInit): Promise<ModelPacksFetch> {
  try {
    const response = await fetch(path, init);
    if (response.status === 400 || response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      return {
        kind: "refused",
        detail: typeof body.error === "string" ? body.error : "The hub refused that change.",
      };
    }
    if (!response.ok) {
      return { kind: "unreachable", detail: `${path} answered ${response.status}` };
    }
    return { kind: "ok", data: parseModelPacks(await response.json()) };
  } catch (error) {
    return {
      kind: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getModelPacks(): Promise<ModelPacksFetch> {
  return fetchPacks("/api/model-packs");
}

/** Pick a pack. It answers the next turn; the one in flight keeps the model it started with. */
export function putActivePack(id: string): Promise<ModelPacksFetch> {
  return fetchPacks("/api/model-packs/active", {
    method: "PUT",
    body: JSON.stringify({ id }),
    headers: { "content-type": "application/json" },
  });
}

/** Make a pack. The hub checks every model with the same function its boot check uses. */
export function createModelPack(
  name: string,
  models: Record<string, string>,
): Promise<ModelPacksFetch> {
  return fetchPacks("/api/model-packs", {
    method: "POST",
    body: JSON.stringify({ name, models }),
    headers: { "content-type": "application/json" },
  });
}

/** Delete a pack this machine made. A built-in comes back refused, with the reason. */
export function deleteModelPack(id: string): Promise<ModelPacksFetch> {
  return fetchPacks(`/api/model-packs/${encodeURIComponent(id)}`, { method: "DELETE" });
}
