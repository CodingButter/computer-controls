import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ApplicationIcon } from "../ports.ts";

/**
 * Finding the picture a freedesktop machine draws for an application.
 *
 * The `Icon=` key in a desktop entry is either an absolute path — rare, and
 * trivially handled — or a bare name that has to be found somewhere in the icon
 * theme search path.
 *
 * Deliberately not a full implementation of the Icon Theme Specification: this
 * does not read `index.theme`, so it does not know which theme a person picked
 * or which themes that one inherits from. It searches every root and takes the
 * best file by name. The cost of skipping that is cosmetic — on a machine with
 * several themes installed, an icon may come from a theme other than the one
 * the desktop is drawing with, so a row can look slightly out of place beside
 * the taskbar. The benefit is that it always finds *something* where a strict
 * implementation returns nothing for an application that only ships a hicolor
 * fallback, which is most of them.
 */

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".xpm": "image/x-xpixmap",
};

const EXTENSIONS = Object.keys(MEDIA_TYPES);

/** How deep into a theme tree to look: theme, size, context, file. */
const MAX_DEPTH = 4;

/** Roots the icon lookup searches, most-specific first. */
export function iconDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || os.homedir();
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
    .split(":")
    .filter((dir) => dir.length > 0);
  return [
    path.join(dataHome, "icons"),
    path.join(home, ".icons"),
    ...dataDirs.map((dir) => path.join(dir, "icons")),
    // Not a theme tree at all: the flat legacy dump, searched last because
    // anything a theme provides is a better answer than what landed here.
    ...dataDirs.map((dir) => path.join(dir, "pixmaps")),
  ];
}

/**
 * How good a candidate file is, higher wins.
 *
 * Scalable beats every raster size because it renders cleanly at whatever size
 * the caller draws it; among rasters, bigger beats smaller for the same reason.
 * The size comes from the conventional `48x48` path segment, and a path with no
 * such segment scores lowest rather than being discarded — a found icon beats
 * no icon.
 */
function score(file: string): number {
  if (file.endsWith(".svg")) return 100_000;
  const match = /(\d+)x\1/.exec(file);
  return match ? Number(match[1]) : 1;
}

/** Every icon file under the search path, by bare name, best candidate first. */
export type IconIndex = Map<string, string[]>;

async function walk(dir: string, depth: number, index: IconIndex): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      // Both halves of a theme tree are commonly symlinks: whole themes linked
      // into a second root, and individual sizes linked at the scalable file.
      // Following neither would lose real icons, so resolve and ask.
      isDir = await stat(full)
        .then((info) => info.isDirectory())
        .catch(() => false);
    }
    if (isDir) {
      if (depth < MAX_DEPTH) await walk(full, depth + 1, index);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!MEDIA_TYPES[ext]) continue;
    const name = entry.name.slice(0, -ext.length);
    const found = index.get(name);
    if (found) found.push(full);
    else index.set(name, [full]);
  }
}

/**
 * Read the search path once and keep the answer.
 *
 * The walk crosses several thousand files on an ordinary desktop, and a
 * dashboard asks for a few hundred icons in a row. Doing it per lookup is the
 * difference between a list that renders and one that hangs. The cost is that
 * an application installed after this hub started has no icon until it
 * restarts — the same restart the desktop census already needs before a new
 * application shows up at all.
 */
export async function buildIconIndex(dirs: string[]): Promise<IconIndex> {
  const index: IconIndex = new Map();
  for (const dir of dirs) await walk(dir, 0, index);
  for (const files of index.values()) files.sort((a, b) => score(b) - score(a));
  return index;
}

async function read(file: string): Promise<ApplicationIcon | undefined> {
  const mediaType = MEDIA_TYPES[path.extname(file)];
  if (!mediaType) return undefined;
  const bytes = await readFile(file).catch(() => undefined);
  if (!bytes) return undefined;
  return { bytes: new Uint8Array(bytes), mediaType };
}

/**
 * Resolve an `Icon=` value to bytes.
 *
 * An absolute value is read as-is, because that is what the key means and only
 * a package or the person themselves can write one. Note what that does *not*
 * grant: the media type comes from the extension, so a value pointing at
 * something that is not an image resolves to nothing. And a desktop entry under
 * a person's own data directory is writable by anything already running as
 * them — which can read those same files directly anyway, so honouring the key
 * hands out no reach that the writer did not already have.
 *
 * A bare name is looked up in the index, and the best-scoring match wins
 * outright. The alternative, first-match-wins per root, reliably returns a
 * 16-pixel tray icon because that directory sorts before `48x48`.
 */
export async function readThemeIcon(
  icon: string,
  index: IconIndex,
): Promise<ApplicationIcon | undefined> {
  if (path.isAbsolute(icon)) return read(icon);
  // A bare name is a file basename in a theme tree. A separator or a null byte
  // in one is not an icon that failed to resolve; it is an entry trying to
  // point the reader somewhere it was never meant to look.
  if (icon.length === 0 || icon.includes("/") || icon.includes("\0")) return undefined;
  // Some entries name the file rather than the icon. Strip a known extension so
  // "firefox.png" and "firefox" find the same picture.
  const ext = path.extname(icon);
  const name = EXTENSIONS.includes(ext) ? icon.slice(0, -ext.length) : icon;
  for (const file of index.get(name) ?? []) {
    const bytes = await read(file);
    if (bytes) return bytes;
  }
  return undefined;
}
