/**
 * The one place that knows the hub's API shapes. Every page fetches through
 * here; a route changing shape breaks one file and its test, not five pages.
 *
 * The dashboard is a static export — there is no server between it and the
 * hub, so everything is a client-side fetch against the same origin.
 */

/** What /api/health reports about a voice- or orb-shaped capability. */
export type CapabilityStatus =
  | { enabled: true }
  | { enabled: false; reason: string };

export type ModelPack = {
  pack: string;
  thinking?: string;
  tiers: Record<string, string>;
};

export type HubHealth = {
  ok: boolean;
  tools: readonly string[];
  desktopScope?: string;
  plugins: { admitted: readonly string[]; refused: readonly string[] };
  model?: ModelPack;
  voice?: CapabilityStatus;
  orb?: CapabilityStatus;
};

/** /api/orb/status — the refused shape carries the reason a person should see. */
export type OrbStatus =
  | { enabled: true; state: string; gate: string; languages: readonly string[] }
  | { enabled: false; reason: string };

/**
 * The page's honest states: data, or the named reason there is none. An
 * unreachable hub is a fact worth showing, never something to paper over
 * with a fake green card.
 */
export type Fetched<T> = { kind: "ok"; data: T } | { kind: "unreachable"; detail: string };

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Parse without trusting: the hub is ours, but a half-started hub or a proxy
 * error page should read as unreachable, not as a crash in the render.
 */
export function parseHealth(body: unknown): HubHealth {
  if (typeof body !== "object" || body === null || !("ok" in body)) {
    throw new Error("not a health response");
  }
  const raw = body as Record<string, unknown>;
  const plugins =
    typeof raw.plugins === "object" && raw.plugins !== null
      ? (raw.plugins as Record<string, unknown>)
      : {};
  return {
    ok: raw.ok === true,
    tools: asStringArray(raw.tools),
    desktopScope: typeof raw.desktopScope === "string" ? raw.desktopScope : undefined,
    plugins: {
      admitted: asStringArray(plugins.admitted),
      refused: asStringArray(plugins.refused),
    },
    model: parseModel(raw.model),
    voice: parseCapability(raw.voice),
    orb: parseCapability(raw.orb),
  };
}

function parseModel(value: unknown): ModelPack | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.pack !== "string") return undefined;
  const tiers: Record<string, string> = {};
  if (typeof raw.tiers === "object" && raw.tiers !== null) {
    for (const [tier, model] of Object.entries(raw.tiers)) {
      if (typeof model === "string") tiers[tier] = model;
    }
  }
  return {
    pack: raw.pack,
    thinking: typeof raw.thinking === "string" ? raw.thinking : undefined,
    tiers,
  };
}

function parseCapability(value: unknown): CapabilityStatus | undefined {
  if (typeof value !== "object" || value === null || !("enabled" in value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.enabled === true) return { enabled: true };
  return { enabled: false, reason: typeof raw.reason === "string" ? raw.reason : "disabled" };
}

export function parseOrbStatus(body: unknown): OrbStatus {
  if (typeof body !== "object" || body === null || !("enabled" in body)) {
    throw new Error("not an orb status response");
  }
  const raw = body as Record<string, unknown>;
  if (raw.enabled === true) {
    return {
      enabled: true,
      state: typeof raw.state === "string" ? raw.state : "unknown",
      gate: typeof raw.gate === "string" ? raw.gate : "unknown",
      languages: asStringArray(raw.languages),
    };
  }
  return { enabled: false, reason: typeof raw.reason === "string" ? raw.reason : "disabled" };
}

async function fetchJson<T>(path: string, parse: (body: unknown) => T): Promise<Fetched<T>> {
  try {
    const response = await fetch(path);
    if (!response.ok) {
      return { kind: "unreachable", detail: `${path} answered ${response.status}` };
    }
    return { kind: "ok", data: parse(await response.json()) };
  } catch (error) {
    return {
      kind: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getHealth(): Promise<Fetched<HubHealth>> {
  return fetchJson("/api/health", parseHealth);
}

export function getOrbStatus(): Promise<Fetched<OrbStatus>> {
  return fetchJson("/api/orb/status", parseOrbStatus);
}

/** One row of the permissions checklist, as the hub's merged view reports it. */
export type PermissionRow = {
  name: string;
  permitted: boolean;
  running: boolean;
  /** Running on the accessibility bus. Running-but-not-readable is the "needs a restart" state. */
  readable: boolean;
  desktopId?: string;
};

export type PermissionsView = {
  mode: "open" | "per-application";
  daemon: { reachable: true } | { reachable: false; reason: string };
  applications: readonly PermissionRow[];
};

/**
 * Permissions can fail a third way health cannot: the user's hand-written
 * config file refuses to parse, and the hub refuses to guess (409). That is
 * not "unreachable" — the hub answered, with a reason worth showing verbatim.
 */
export type PermissionsFetch =
  | { kind: "ok"; data: PermissionsView }
  | { kind: "unreachable"; detail: string }
  | { kind: "refused"; detail: string };

export function parsePermissions(body: unknown): PermissionsView {
  if (typeof body !== "object" || body === null || !("applications" in body)) {
    throw new Error("not a permissions response");
  }
  const raw = body as Record<string, unknown>;
  const daemon =
    typeof raw.daemon === "object" && raw.daemon !== null
      ? (raw.daemon as Record<string, unknown>)
      : {};
  return {
    mode: raw.mode === "per-application" ? "per-application" : "open",
    daemon:
      daemon.reachable === true
        ? { reachable: true }
        : {
            reachable: false,
            reason: typeof daemon.reason === "string" ? daemon.reason : "unreachable",
          },
    applications: (Array.isArray(raw.applications) ? raw.applications : [])
      .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
      .filter((row) => typeof row.name === "string")
      .map((row) => ({
        name: row.name as string,
        permitted: row.permitted === true,
        running: row.running === true,
        readable: row.readable === true,
        ...(typeof row.desktopId === "string" ? { desktopId: row.desktopId } : {}),
      })),
  };
}

async function fetchPermissions(
  path: string,
  init?: RequestInit,
): Promise<PermissionsFetch> {
  try {
    const response = await fetch(path, init);
    if (response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      return {
        kind: "refused",
        detail:
          typeof body.error === "string" ? body.error : "The hub refused to read the config.",
      };
    }
    if (!response.ok) {
      return { kind: "unreachable", detail: `${path} answered ${response.status}` };
    }
    return { kind: "ok", data: parsePermissions(await response.json()) };
  } catch (error) {
    return {
      kind: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getPermissions(): Promise<PermissionsFetch> {
  return fetchPermissions("/api/permissions");
}

/** The page's one write: toggle a single application, exactly as named. */
export function putPermission(app: string, permitted: boolean): Promise<PermissionsFetch> {
  return fetchPermissions(`/api/permissions/${encodeURIComponent(app)}`, {
    method: "PUT",
    body: JSON.stringify({ permitted }),
    headers: { "content-type": "application/json" },
  });
}
