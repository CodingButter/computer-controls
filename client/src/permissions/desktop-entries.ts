import fs from "node:fs";
import path from "node:path";

/**
 * The machine's installed applications, read from .desktop files.
 *
 * The daemon's census only knows what is running right now; the permissions
 * page must also offer the applications a user could launch, because "permit
 * Discord" is a decision they should be able to make while Discord is closed.
 * The freedesktop application directories are where that answer lives.
 */

export type DesktopEntryApp = {
  /** The desktop file's Name= — what a launcher shows, and what we match on. */
  name: string;
  /** The desktop-file id (its filename), the stable handle curing will use. */
  desktopId: string;
  /** The Exec= line, kept for Chromium detection when curing arrives. */
  exec?: string;
};

export const SYSTEM_APPLICATIONS_DIR = "/usr/share/applications";

export function userApplicationsDir(home: string): string {
  return path.join(home, ".local", "share", "applications");
}

/**
 * Scan the given directories for launchable applications.
 *
 * Later directories win on id collisions — pass the system directory first
 * and the user directory second, which is exactly the freedesktop precedence
 * and the mechanism curing's user-scope overrides will lean on.
 */
export function scanDesktopEntries(dirs: string[]): DesktopEntryApp[] {
  const byId = new Map<string, DesktopEntryApp>();
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue; // A missing directory is a machine without that scope, not an error.
    }
    for (const file of files) {
      if (!file.endsWith(".desktop")) continue;
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, file), "utf8");
      } catch {
        continue;
      }
      const entry = parseDesktopEntry(text);
      if (!entry) continue;
      byId.set(file, { ...entry, desktopId: file });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The [Desktop Entry] section only, honestly parsed: an entry hidden from
 * launchers (NoDisplay, Hidden) is hidden here too, because offering a
 * permission toggle for an application the user has never seen in a menu
 * would be noise pretending to be choice.
 */
function parseDesktopEntry(text: string): { name: string; exec?: string } | undefined {
  let inEntry = false;
  let name: string | undefined;
  let exec: string | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inEntry = trimmed === "[Desktop Entry]";
      continue;
    }
    if (!inEntry) continue;
    if (trimmed.startsWith("Name=") && name === undefined) name = trimmed.slice(5).trim();
    else if (trimmed.startsWith("Exec=") && exec === undefined) exec = trimmed.slice(5).trim();
    else if (trimmed === "NoDisplay=true" || trimmed === "Hidden=true") return undefined;
  }
  if (!name) return undefined;
  return { name, ...(exec ? { exec } : {}) };
}
