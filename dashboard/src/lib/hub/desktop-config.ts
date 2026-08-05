/**
 * /api/desktop-config — the one door onto the user's configuration file, and
 * the one write behind all three Settings depths.
 *
 * There is deliberately no per-depth endpoint here. Easy is not a smaller API
 * with fewer fields; it is this response with fewer fields drawn. A route per
 * lens is how three depths quietly become three products that disagree about
 * what the configuration is.
 */

export type ConfigObject = Record<string, unknown>;

/** What every lens is told, whichever depth is drawing it. */
export type DesktopConfigView = {
  /** The file's contents, entire — including keys no lens owns. */
  config: ConfigObject;
  /** False before the file has ever been written; the defaults are live either way. */
  exists: boolean;
  /** Shown by Advanced, because someone editing their ceiling should know which file they are editing. */
  path: string;
  /** The keys this surface may write. Everything else is displayed and left alone. */
  owns: readonly string[];
  /** What the daemon uses for a key the file does not set. */
  defaults: {
    permissionsMode: string;
    operationClasses: readonly string[];
    confirmClasses: readonly string[];
    idleExpirySeconds: number;
    audit: boolean;
  };
  /** The vocabularies, so a lens offers exactly the values the daemon accepts. */
  vocabulary: {
    permissionsModes: readonly string[];
    operationClasses: readonly string[];
  };
};

/**
 * Settings can fail two ways beyond an unreachable hub, and both are the hub
 * answering with a reason rather than the hub being gone:
 *
 * 409 — the file on disk will not parse, so nothing was written. Papering over
 * this is precisely the bug the write path exists to prevent.
 * 400 — the edit itself was refused: a key this surface does not own, or a
 * value the daemon would not accept.
 *
 * Both carry a sentence written for a person. Neither is "unreachable", and
 * neither may be shown as a success.
 */
export type DesktopConfigFetch =
  | { kind: "ok"; data: DesktopConfigView }
  | { kind: "unreachable"; detail: string }
  | { kind: "refused"; detail: string };

function asStrings(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : fallback;
}

export function parseDesktopConfig(body: unknown): DesktopConfigView {
  if (typeof body !== "object" || body === null || !("config" in body)) {
    throw new Error("not a desktop-config response");
  }
  const raw = body as Record<string, unknown>;
  const defaults = (
    typeof raw.defaults === "object" && raw.defaults !== null ? raw.defaults : {}
  ) as Record<string, unknown>;
  const vocabulary = (
    typeof raw.vocabulary === "object" && raw.vocabulary !== null ? raw.vocabulary : {}
  ) as Record<string, unknown>;

  return {
    config:
      typeof raw.config === "object" && raw.config !== null && !Array.isArray(raw.config)
        ? (raw.config as ConfigObject)
        : {},
    exists: raw.exists === true,
    path: typeof raw.path === "string" ? raw.path : "",
    owns: asStrings(raw.owns, []),
    defaults: {
      permissionsMode:
        typeof defaults.permissionsMode === "string" ? defaults.permissionsMode : "open",
      operationClasses: asStrings(defaults.operationClasses, ["observe"]),
      confirmClasses: asStrings(defaults.confirmClasses, ["submit", "destructive"]),
      idleExpirySeconds:
        typeof defaults.idleExpirySeconds === "number" ? defaults.idleExpirySeconds : 1800,
      audit: defaults.audit !== false,
    },
    vocabulary: {
      permissionsModes: asStrings(vocabulary.permissionsModes, ["open", "per-application"]),
      operationClasses: asStrings(vocabulary.operationClasses, []),
    },
  };
}

async function fetchDesktopConfig(init?: RequestInit): Promise<DesktopConfigFetch> {
  try {
    const response = await fetch("/api/desktop-config", init);
    if (response.status === 409 || response.status === 400) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      return {
        kind: "refused",
        detail:
          typeof body.error === "string"
            ? body.error
            : "The hub refused the change and did not say why.",
      };
    }
    if (!response.ok) {
      return { kind: "unreachable", detail: `/api/desktop-config answered ${response.status}` };
    }
    return { kind: "ok", data: parseDesktopConfig(await response.json()) };
  } catch (error) {
    return {
      kind: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getDesktopConfig(): Promise<DesktopConfigFetch> {
  return fetchDesktopConfig();
}

/**
 * The page's one write: named leaf keys, never the whole object.
 *
 * This signature is the losslessness guarantee at the dashboard's end. A lens
 * cannot send a document, so a lens cannot delete the keys it does not draw —
 * not by discipline, but because there is no call that would let it. Sending
 * `{ ...config, ...changes }` is the bug this shape makes unavailable.
 */
export function putDesktopSettings(edits: Record<string, unknown>): Promise<DesktopConfigFetch> {
  return fetchDesktopConfig({
    method: "PUT",
    body: JSON.stringify({ edits }),
    headers: { "content-type": "application/json" },
  });
}
