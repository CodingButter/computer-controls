import os from "node:os";
import path from "node:path";

import type { HubPaths, HubPlatform } from "../ports.ts";
import { freedesktopAutostart } from "./autostart.ts";
import { applicationDirs, findDesktopEntry, scanDesktopEntries } from "./entries.ts";
import { buildIconIndex, iconDirs, readThemeIcon, type IconIndex } from "./icons.ts";

/**
 * The adapter for Linux and the BSDs — everything that follows the freedesktop
 * conventions.
 *
 * The only complete adapter today, because it is the desktop this was built and
 * measured on. The other two exist so that the day someone starts on macOS the
 * work is filling in a named file, not finding every place `.desktop` leaked
 * into the core.
 */

/** XDG base directories, with the spec's own defaults. */
export function freedesktopPaths(
  env: NodeJS.ProcessEnv = process.env,
  app = "mastracode-desktop",
): HubPaths {
  const home = env.HOME ?? os.homedir();
  return {
    config: path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), app),
    state: path.join(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), app),
  };
}

export function freedesktopPlatform(env: NodeJS.ProcessEnv = process.env): HubPlatform {
  // Resolved once at construction rather than per call: the search path is a
  // property of the session's environment, and re-reading it per icon would let
  // a mid-run environment change hand back icons from a different theme than
  // the names beside them came from.
  const appDirs = applicationDirs(env);
  const themeDirs = iconDirs(env);
  // Built on the first icon asked for rather than at boot — a hub whose person
  // never opens the dashboard should not pay for a walk of every theme on the
  // machine — and shared by every caller after that. Held as the promise, not
  // its result, so a burst of concurrent lookups waits on one walk instead of
  // starting one each.
  let index: Promise<IconIndex> | undefined;
  return {
    id: "freedesktop",
    paths: freedesktopPaths(env),
    scanInstalled: () => scanDesktopEntries(appDirs),
    icons: async (applicationId) => {
      const entry = await findDesktopEntry(appDirs, applicationId);
      if (!entry?.icon) return undefined;
      index ??= buildIconIndex(themeDirs);
      return readThemeIcon(entry.icon, await index);
    },
    autostart: freedesktopAutostart(env),
    supports: {
      installedScan: true,
      icons: true,
      // The `.desktop` override is how a launcher is cured here, and #115
      // shipped the curing that uses it.
      shortcutCuring: true,
      autostart: true,
    },
  };
}
