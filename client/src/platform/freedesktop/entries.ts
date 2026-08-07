import fs from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { InstalledApplication } from "../ports.ts";

/**
 * Reading `.desktop` files, which is how a freedesktop machine says what it has
 * installed.
 *
 * Kept apart from the adapter that uses it because this is the half that is
 * purely about the file format: give it directories, it gives back entries. The
 * adapter decides which directories those are.
 */

/** One parsed entry, including the fields only the icon lookup cares about. */
export type DesktopEntry = InstalledApplication & {
  /** The `Icon=` value verbatim: a theme name, or an absolute path. */
  icon?: string;
  /** Absolute path of the file this came from. */
  source: string;
};

/**
 * The search path, most-specific first.
 *
 * Order is the whole contract: a `.desktop` file a person installed into their
 * own data directory shadows the system copy of the same id, which is how
 * overrides work on this platform — and how a cured shortcut takes effect
 * without touching anything root owns.
 */
export function applicationDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || os.homedir();
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
    .split(":")
    .filter((dir) => dir.length > 0);
  return [dataHome, ...dataDirs].map((dir) => path.join(dir, "applications"));
}

/**
 * The desktop-icon directory, if this machine has one that exists.
 *
 * `user-dirs.dirs` is the file the XDG user-dirs tool writes and the file
 * managers read, so it is the only authority on a desktop that is not named
 * "Desktop" — a localised install may call it something else entirely, and a
 * hardcoded `~/Desktop` would silently cure nothing there. The env var is
 * checked first because a caller that sets it means it.
 *
 * Returns only directories that exist: these are read to be edited in place,
 * and this function never invents a desktop that the session does not have.
 */
export function desktopIconDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || os.homedir();
  const candidates: string[] = [];

  if (env.XDG_DESKTOP_DIR) candidates.push(env.XDG_DESKTOP_DIR);

  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  try {
    const declared = fs.readFileSync(path.join(configHome, "user-dirs.dirs"), "utf8");
    const match = declared.match(/^\s*XDG_DESKTOP_DIR\s*=\s*"(.*)"\s*$/m);
    if (match?.[1]) candidates.push(match[1].replace(/^\$HOME/, home));
  } catch {
    // No user-dirs file is ordinary: the fallback below is the spec's default.
  }

  candidates.push(path.join(home, "Desktop"));

  const seen = new Set<string>();
  return candidates.filter((dir) => {
    if (seen.has(dir)) return false;
    seen.add(dir);
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Pull the `[Desktop Entry]` group out of a desktop file.
 *
 * Only that group: the `Desktop Action` groups further down repeat keys like
 * `Name` and `Icon` for each right-click action, and a parser that read the
 * whole file would hand back the name of an action as the name of the
 * application.
 */
function parseEntry(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  let inEntry = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line.length === 0) continue;
    if (line.startsWith("[")) {
      if (inEntry) break;
      inEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inEntry) continue;
    const split = line.indexOf("=");
    if (split < 0) continue;
    const key = line.slice(0, split).trim();
    if (fields.has(key)) continue;
    fields.set(key, line.slice(split + 1).trim());
  }
  return fields;
}

function toEntry(text: string, source: string, id: string): DesktopEntry | undefined {
  const fields = parseEntry(text);
  // Type is required by the spec, but a missing one is common enough in the
  // wild that treating it as "application" reads better than dropping a real
  // application from a person's list over a spec violation they cannot fix.
  if ((fields.get("Type") ?? "Application") !== "Application") return undefined;
  // Both flags mean the desktop is being asked not to show this. Honour them:
  // the list exists so a person can pick, and entries their own desktop hides
  // are noise at best and confusing at worst.
  if (fields.get("NoDisplay") === "true" || fields.get("Hidden") === "true") return undefined;
  const icon = fields.get("Icon");
  return {
    id,
    name: fields.get("Name") ?? id,
    source,
    ...(icon ? { icon } : {}),
  };
}

/**
 * Every application installed on this machine, shadowing by id.
 *
 * Unreadable directories and unreadable files are skipped rather than raised.
 * A stale symlink in one data directory is not a reason a person cannot see the
 * other three hundred applications they have installed.
 */
export async function scanDesktopEntries(dirs: string[]): Promise<DesktopEntry[]> {
  const byId = new Map<string, DesktopEntry>();
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".desktop")) continue;
      const id = name.slice(0, -".desktop".length);
      if (byId.has(id)) continue;
      const source = path.join(dir, name);
      const text = await readFile(source, "utf8").catch(() => undefined);
      if (text === undefined) continue;
      const entry = toEntry(text, source, id);
      if (entry) byId.set(id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One entry by id, following the same shadowing order as a full scan. */
export async function findDesktopEntry(
  dirs: string[],
  id: string,
): Promise<DesktopEntry | undefined> {
  // An id is a file basename here, so a caller-supplied one could otherwise
  // walk out of the applications directories entirely.
  if (id.length === 0 || id.includes("/") || id.includes("\0")) return undefined;
  for (const dir of dirs) {
    const source = path.join(dir, `${id}.desktop`);
    const text = await readFile(source, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const entry = toEntry(text, source, id);
    if (entry) return entry;
  }
  return undefined;
}
