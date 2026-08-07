/**
 * Start on login, the freedesktop way: a `.desktop` file in
 * `$XDG_CONFIG_HOME/autostart`.
 *
 * The entry is the person's own config, so it is edited the way the
 * desktop-config door edits `config.json`: temp file then rename, atomic
 * within a directory on POSIX, so the session manager can never read a
 * half-written entry at login. Disabling removes the file rather than writing
 * `Hidden=true` — an absent entry is the state a person can verify with `ls`,
 * and there is nothing in the file worth preserving.
 */

import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Autostart, AutostartEntry } from "../ports.ts";

/**
 * Where the session manager looks, with the spec's own default. Empty counts as
 * unset, the same reading the rest of this adapter gives it: an empty
 * `XDG_CONFIG_HOME` taken as an answer would write the entry to a relative
 * `autostart/` beside wherever the hub was started, and the session manager
 * would go on finding nothing at login.
 */
export function autostartDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || os.homedir();
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "autostart");
}

/**
 * The entry as written. A line break in a field would let one field author
 * another — `Name` ending in `\nExec=` is a command injection with a friendly
 * face — so fields with control characters are refused whole rather than
 * escaped: nothing this hub writes has a legitimate newline in its name.
 */
export function desktopEntryFor(entry: AutostartEntry): string {
  for (const [field, value] of [
    ["id", entry.id],
    ["name", entry.name],
    ["exec", entry.exec],
  ]) {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(value) || value.length === 0) {
      throw new Error(`a desktop entry ${field} cannot be empty or contain control characters`);
    }
  }
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${entry.name}`,
    `Exec=${entry.exec}`,
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

export function freedesktopAutostart(env: NodeJS.ProcessEnv = process.env): Autostart {
  const entryPath = (id: string) => path.join(autostartDir(env), `${id}.desktop`);
  return {
    path: entryPath,
    read: (id) =>
      access(entryPath(id)).then(
        () => true,
        () => false,
      ),
    write: async (entry, enabled) => {
      const file = entryPath(entry.id);
      if (!enabled) {
        await rm(file, { force: true });
        return;
      }
      const content = desktopEntryFor(entry);
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, content, { encoding: "utf8", mode: 0o644 });
      await rename(temp, file);
    },
  };
}
