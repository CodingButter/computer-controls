/**
 * The user's desktop configuration, read and rewritten by the hub as the user.
 *
 * The daemon reads `~/.config/mastracode-desktop/config.json` to learn its
 * ceiling, and nothing reachable over the daemon socket may write it — that
 * asymmetry is the whole consent design, not an implementation detail. The hub
 * is a different animal: it is a process the user started, running as the user,
 * so it may edit the user's own file the way a text editor may. This module is
 * that hand, and it is deliberately the only one in the hub.
 *
 * Three promises, each of which exists because its absence is a known way to
 * lose someone's configuration:
 *
 * - **It owns only what it edits.** A settings page that writes back the whole
 *   object writes back the whole object *as it understood it*, which silently
 *   deletes every key it was never taught about — a hand-written allowlist, a
 *   key from a newer version, a field the page's author had not shipped yet.
 *   So edits are addressed leaf by leaf, and everything else is carried through
 *   untouched at every depth.
 * - **A malformed file is refused, never overwritten.** Reading a file with a
 *   trailing comma as an empty object and then saving over it turns one typo
 *   into a total loss, in the safe direction, which is exactly how nobody
 *   notices. `service/desktop_service/config.py` refuses for the same reason;
 *   this is the write-side twin of that refusal.
 * - **It never writes a file the daemon will then refuse.** The daemon raises
 *   on an unknown operation class or a misspelled `permissionsMode`. A page
 *   that could save one would be a page that bricks the ceiling from a
 *   dropdown, so every value is checked here against the same vocabulary
 *   `security.Ceiling.from_config` checks it against.
 *
 * The shape mirrors `service/desktop_service/config.py` and the reader in
 * `service/desktop_service/security.py`. The two can drift, so the key map
 * below records where each key is actually read, and the tests assert the
 * vocabulary rather than trusting the comment.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The complete operation vocabulary, frozen in `protocol/schema.json` and
 * mirrored into `security.OPERATION_CLASSES`. Both `operationClasses` and
 * `confirmClasses` are checked against it.
 *
 * A hand copy, because the generated bindings live in the plugin package and
 * this one does not reach across that boundary. Hand copies drift, so
 * `config-file.test.ts` reads the schema and asserts this list against it — the
 * same guard `plugin/src/protocol.test.ts` puts on the generated copy. Drift
 * here fails closed (a newly frozen class would be refused rather than let
 * through), and the test turns "fails closed, quietly, for a release" into a
 * red build.
 */
export const OPERATION_CLASSES = ["observe", "edit", "activate", "submit", "destructive"] as const;

/** `security.PERMISSIONS_MODES`. A value outside this list is refused loudly there, so it is refused here. */
export const PERMISSIONS_MODES = ["open", "per-application"] as const;

/**
 * The keys this surface may write, addressed as paths into the object.
 *
 * What is absent matters more than what is present. `scopes.applications` and
 * `scopes.blockedApplications` are the per-application permissions registry —
 * the Permissions page's territory, and the reason the Easy lens links there
 * instead of drawing checkboxes of its own. Leaving them out of this list is
 * what makes "the settings page cannot clobber your permissions" a property of
 * the code rather than a promise in a comment.
 */
export const SETTINGS_KEYS = [
  "scopes.permissionsMode",
  "scopes.operationClasses",
  "scopes.confirmClasses",
  "scopes.idleExpirySeconds",
  "sensitiveApplications",
  "audit",
  "auditPath",
] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

export type ConfigObject = Record<string, unknown>;

/**
 * A file that exists but cannot be read as configuration.
 *
 * Its own class because the callers have to tell it apart from "no file yet":
 * absence is the safe answer and yields defaults, whereas this must stop a
 * write before it happens.
 */
export class MalformedConfig extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "MalformedConfig";
  }
}

export type ConfigDocument = {
  /** The parsed object, or `{}` when there is no file yet. */
  config: ConfigObject;
  /**
   * Whether a file was actually there. The daemon distinguishes these too: a
   * missing config is a machine nobody has configured, and its refusals say
   * "create this file" rather than "widen this file".
   */
  exists: boolean;
};

/**
 * Read the configuration, or return the safe default.
 *
 * Mirrors `config.py:load`, including its two refusals — invalid JSON and a
 * non-object document — because a file this module would refuse to parse is a
 * file the daemon has already refused to start on.
 */
export async function readConfigFile(file: string): Promise<ConfigDocument> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: {}, exists: false };
    throw error;
  }
  let loaded: unknown;
  try {
    loaded = JSON.parse(text);
  } catch (error) {
    throw new MalformedConfig(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (loaded === null || typeof loaded !== "object" || Array.isArray(loaded)) {
    throw new MalformedConfig(`${file} must contain a JSON object`);
  }
  return { config: loaded as ConfigObject, exists: true };
}

/**
 * Write the configuration so that a reader never sees a half-written file.
 *
 * Temp file then rename, which is atomic within a directory on POSIX: the
 * daemon stats this path on every request to decide whether to rebuild its
 * ceiling, so a reader arriving mid-write is a routine event here rather than a
 * rare one. The mode matches the socket's `0600` — this file decides what an
 * agent may do to the desktop, and it is nobody else's business.
 */
export async function writeConfigFile(file: string, config: ConfigObject): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, file);
}

export type MergeResult =
  | { ok: true; config: ConfigObject }
  | { ok: false; reason: string };

/**
 * Apply a set of edits to a configuration, touching nothing else.
 *
 * An edit naming a key outside `SETTINGS_KEYS` is refused rather than dropped.
 * Dropping it would mean a page could show a control, accept a click, report
 * success, and change nothing — the failure that is worst precisely because it
 * looks like the success.
 *
 * Unowned keys survive by never being visited: the copy is structural only
 * along the paths being written, so a sibling subtree comes out the far side as
 * the same values in the same order it went in. Whitespace does not survive,
 * because the document is re-serialised; values and ordering do.
 */
export function mergeSettings(existing: ConfigObject, edits: ConfigObject): MergeResult {
  const owned = new Set<string>(SETTINGS_KEYS);
  for (const key of Object.keys(edits)) {
    if (!owned.has(key)) {
      return {
        ok: false,
        reason: `${key} is not a setting this page owns (it may write: ${SETTINGS_KEYS.join(", ")})`,
      };
    }
  }

  const next: ConfigObject = { ...existing };
  for (const key of SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(edits, key)) continue;
    const checked = checkValue(key, edits[key]);
    if (!checked.ok) return checked;

    const dot = key.indexOf(".");
    if (dot === -1) {
      next[key] = checked.value;
      continue;
    }
    // Exactly one level of nesting exists in this file, and spelling it out
    // beats a general path-walker that would have to invent behaviour for
    // depths the config has never had.
    const parent = key.slice(0, dot);
    const leaf = key.slice(dot + 1);
    const branch = next[parent];
    if (branch !== undefined && (branch === null || typeof branch !== "object" || Array.isArray(branch))) {
      // Replacing it with a fresh object would be the silent overwrite wearing
      // a different hat: the daemon cannot read this file either, so the person
      // is mid-repair on it, and the repair is theirs to finish.
      return {
        ok: false,
        reason: `${parent} in this configuration is not an object, so ${key} cannot be set without discarding it. Nothing was written.`,
      };
    }
    next[parent] = { ...((branch as ConfigObject | undefined) ?? {}), [leaf]: checked.value };
  }
  return { ok: true, config: next };
}

type CheckResult = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Refuse a value the daemon would refuse, at the point where a person can still
 * do something about it.
 */
function checkValue(key: SettingsKey, value: unknown): CheckResult {
  switch (key) {
    case "scopes.permissionsMode": {
      const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
      if (!(PERMISSIONS_MODES as readonly string[]).includes(mode)) {
        return {
          ok: false,
          reason: `permissionsMode must be one of ${PERMISSIONS_MODES.join(", ")}`,
        };
      }
      return { ok: true, value: mode };
    }
    case "scopes.operationClasses":
    case "scopes.confirmClasses": {
      const classes = asStringArray(value);
      if (!classes) return { ok: false, reason: `${key} must be an array of strings` };
      const normalised = classes.map((name) => name.trim().toLowerCase());
      const unknown = normalised.filter(
        (name) => !(OPERATION_CLASSES as readonly string[]).includes(name),
      );
      if (unknown.length > 0) {
        return {
          ok: false,
          reason: `unknown operation class in ${key}: ${unknown.join(", ")} (expected one of ${OPERATION_CLASSES.join(", ")})`,
        };
      }
      return { ok: true, value: normalised };
    }
    case "scopes.idleExpirySeconds": {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return { ok: false, reason: "idleExpirySeconds must be a number of seconds, zero or more" };
      }
      return { ok: true, value };
    }
    case "sensitiveApplications": {
      const names = asStringArray(value);
      if (!names) return { ok: false, reason: "sensitiveApplications must be an array of strings" };
      return { ok: true, value: names };
    }
    case "audit": {
      if (typeof value !== "boolean") return { ok: false, reason: "audit must be true or false" };
      return { ok: true, value };
    }
    case "auditPath": {
      if (value === null) return { ok: true, value: null };
      if (typeof value !== "string") {
        return { ok: false, reason: "auditPath must be a path, or null for the default" };
      }
      return { ok: true, value };
    }
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => typeof entry === "string")) return undefined;
  return value as string[];
}
