/** /api/permissions — the merged application view, and the page's one write. */

/**
 * How far inside one application an agent may go. `off`, `view` and `interact`
 * are the states this page sets; `custom` is one only a hand-written config
 * produces, shown as itself rather than rounded to a neighbour.
 */
export type AppAccess = "off" | "view" | "interact" | "custom";

/** One row of the permissions checklist, as the hub's merged view reports it. */
export type PermissionRow = {
  name: string;
  permitted: boolean;
  access: AppAccess;
  /** What is actually in force — present when the row is capped. */
  classes?: readonly string[];
  running: boolean;
  /** Running on the accessibility bus. Running-but-not-readable is the "needs a restart" state. */
  readable: boolean;
  desktopId?: string;
};

export type PermissionsView = {
  mode: "open" | "per-application";
  daemon: { reachable: true } | { reachable: false; reason: string };
  /**
   * The widest any single application can be — `scopes.operationClasses` with
   * its ladder filled in. A desktop whose global classes stop at `observe`
   * cannot have an interactive application in it, and the page says so instead
   * of offering the choice.
   */
  ceiling: readonly string[];
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
    // A hub that does not report one is read as the daemon's own default,
    // which is `observe` and not everything.
    ceiling: Array.isArray(raw.ceiling)
      ? raw.ceiling.filter((entry): entry is string => typeof entry === "string")
      : ["observe"],
    applications: (Array.isArray(raw.applications) ? raw.applications : [])
      .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
      .filter((row) => typeof row.name === "string")
      .map((row) => ({
        name: row.name as string,
        permitted: row.permitted === true,
        access: readAccess(row.access, row.permitted === true),
        ...(Array.isArray(row.classes)
          ? { classes: row.classes.filter((entry): entry is string => typeof entry === "string") }
          : {}),
        running: row.running === true,
        readable: row.readable === true,
        ...(typeof row.desktopId === "string" ? { desktopId: row.desktopId } : {}),
      })),
  };
}

/**
 * An unrecognised access reads as the permitted flag alone. The two always
 * agree when they come from this hub; disagreeing here would mean showing a
 * row as off while the flag beside it says permitted.
 */
function readAccess(value: unknown, permitted: boolean): AppAccess {
  if (value === "off" || value === "view" || value === "interact" || value === "custom") {
    return value;
  }
  return permitted ? "interact" : "off";
}

async function fetchPermissions(path: string, init?: RequestInit): Promise<PermissionsFetch> {
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

/** The page's one write: set a single application's access, exactly as named. */
export function putAccess(
  app: string,
  access: Exclude<AppAccess, "custom">,
): Promise<PermissionsFetch> {
  return fetchPermissions(`/api/permissions/${encodeURIComponent(app)}`, {
    method: "PUT",
    body: JSON.stringify({ access }),
    headers: { "content-type": "application/json" },
  });
}
