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
    return { mode: OPEN_MODE, applications: [], blockedApplications: [], document: {} };
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
    document: doc,
  };
}

function readNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Rewrite only what the permissions page owns — `scopes.permissionsMode` and
 * `scopes.applications` — and keep every other key exactly as found. The
 * config is shared state with whatever the user wrote by hand;
 * `blockedApplications`, `confirmClasses`, `audit` and anything we have never
 * heard of ride through untouched.
 *
 * Written whole via temp file and rename: the daemon re-reads this file on its
 * own schedule, and it must never observe half a write.
 */
export function writePermittedApplications(
  configPath: string,
  document: Record<string, unknown>,
  applications: string[],
): void {
  const scopes = { ...((document.scopes ?? {}) as Record<string, unknown>) };
  scopes.permissionsMode = PER_APPLICATION_MODE;
  scopes.applications = applications;
  const next = { ...document, scopes };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temp = path.join(
    path.dirname(configPath),
    `.config.json.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temp, configPath);
}
