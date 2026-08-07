import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The user-owned daemon config, read and rewritten by the permissions page.
 *
 * This file — `~/.config/mastracode-desktop/config.json` — is the ONLY author
 * of the daemon's consent ceiling. Nothing reachable over the daemon's socket
 * can change it; the hub writes it here as the user's agent, because the
 * permissions page is the user clicking, and the daemon re-reads it on its own
 * (the ceiling watch shipped with the daemon half of #116). The hub never
 * talks the daemon into anything: it edits the user's file and the daemon
 * notices, exactly as if the user had opened an editor.
 */

export const OPEN_MODE = "open";
export const PER_APPLICATION_MODE = "per-application";

export type PermissionsMode = typeof OPEN_MODE | typeof PER_APPLICATION_MODE;

export class MalformedConfigError extends Error {
  constructor(configPath: string, cause: string) {
    // Named loudly rather than silently overwritten: a config the user wrote
    // by hand deserves a refusal that says what is wrong, not a rewrite that
    // quietly discards whatever they were trying to say.
    super(`The config at ${configPath} could not be read as JSON: ${cause}`);
    this.name = "MalformedConfigError";
  }
}

/** Mirrors the daemon's own resolution: XDG_CONFIG_HOME, else ~/.config. */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "mastracode-desktop", "config.json");
}

export type ScopesView = {
  mode: PermissionsMode;
  applications: string[];
  blockedApplications: string[];
  /**
   * `scopes.operationClasses` — what the daemon permits anywhere. Read because
   * a per-application entry is intersected with it: a page that offered
   * "interact" on a desktop whose ceiling stops at `observe` would be
   * promising something the daemon refuses.
   */
  classes: string[];
  /**
   * `scopes.applicationClasses` — how far inside a named application an agent
   * may go. An application absent from this map is governed by `classes`
   * alone, which is the daemon's own reading and the reason an empty map is
   * indistinguishable from no map at all.
   */
  applicationClasses: Record<string, string[]>;
  /** The whole parsed document, kept so a write can preserve what it does not own. */
  document: Record<string, unknown>;
};

/**
 * Read the config and answer the permission-relevant slice of it.
 *
 * An absent file is the daemon's own default: open mode, nothing named,
 * nothing withheld. A malformed file throws — the same loud refusal the
 * daemon's config reader makes, because a silent fallback here would let the
 * page cheerfully display permissions the daemon refused to load.
 */
export function readScopesConfig(configPath: string): ScopesView {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return {
      mode: OPEN_MODE,
      applications: [],
      blockedApplications: [],
      classes: [],
      applicationClasses: {},
      document: {},
    };
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new MalformedConfigError(configPath, (error as Error).message);
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new MalformedConfigError(configPath, "the top level is not an object");
  }

  const doc = document as Record<string, unknown>;
  const scopes = (doc.scopes ?? {}) as Record<string, unknown>;
  if (typeof scopes !== "object" || scopes === null || Array.isArray(scopes)) {
    throw new MalformedConfigError(configPath, "scopes is not an object");
  }

  const mode = scopes.permissionsMode;
  if (mode !== undefined && mode !== OPEN_MODE && mode !== PER_APPLICATION_MODE) {
    // The daemon refuses an unknown mode outright; showing it as "open" here
    // would display everything as permitted while the daemon permits nothing.
    throw new MalformedConfigError(configPath, `unknown permissionsMode "${String(mode)}"`);
  }

  return {
    // Absent means open — the daemon's default, and the transition case the
    // first PUT must handle by writing the mode and the list together.
    mode: (mode as PermissionsMode | undefined) ?? OPEN_MODE,
    applications: readNames(scopes.applications),
    blockedApplications: readNames(scopes.blockedApplications),
    classes: readNames(scopes.operationClasses),
    applicationClasses: readApplicationClasses(configPath, scopes.applicationClasses),
    document: doc,
  };
}

function readNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The per-application class map, refused loudly when it is not one.
 *
 * The daemon raises on a malformed `applicationClasses` and keeps the ceiling
 * it already had, which means a page that shrugged this off would show
 * permissions from a file the daemon never loaded.
 */
function readApplicationClasses(configPath: string, value: unknown): Record<string, string[]> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MalformedConfigError(configPath, "applicationClasses is not an object");
  }
  const entries: Record<string, string[]> = {};
  for (const [name, classes] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(classes) || classes.some((entry) => typeof entry !== "string")) {
      throw new MalformedConfigError(
        configPath,
        `applicationClasses["${name}"] is not an array of strings`,
      );
    }
    entries[name] = classes as string[];
  }
  return entries;
}

/**
 * Rewrite only what the permissions page owns — `scopes.permissionsMode`,
 * `scopes.applications` and `scopes.applicationClasses` — and keep every other
 * key exactly as found. The config is shared state with whatever the user
 * wrote by hand; `blockedApplications`, `confirmClasses`, `audit` and anything
 * we have never heard of ride through untouched.
 *
 * An empty class map deletes the key rather than writing `{}`. The daemon
 * reads the two identically, so leaving an empty object behind would only be
 * this page's litter in a file the user opens and reads.
 *
 * Written whole via temp file and rename: the daemon re-reads this file on its
 * own schedule, and it must never observe half a write.
 */
export function writePermissions(
  configPath: string,
  document: Record<string, unknown>,
  applications: string[],
  applicationClasses: Record<string, string[]>,
): void {
  const scopes = { ...((document.scopes ?? {}) as Record<string, unknown>) };
  scopes.permissionsMode = PER_APPLICATION_MODE;
  scopes.applications = applications;
  if (Object.keys(applicationClasses).length > 0) {
    scopes.applicationClasses = applicationClasses;
  } else {
    delete scopes.applicationClasses;
  }
  const next = { ...document, scopes };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temp = path.join(
    path.dirname(configPath),
    `.config.json.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temp, configPath);
}
