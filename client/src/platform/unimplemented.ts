import os from "node:os";
import path from "node:path";

import type { HubPaths, HubPlatform, PlatformId } from "./ports.ts";

/**
 * The adapters for the OSes whose wave has not come yet.
 *
 * They are real modules with real path resolution rather than a thrown "not
 * supported", because the two halves have different lifetimes. Where a hub is
 * allowed to write on macOS and Windows is settled convention and costs nothing
 * to state now; reading an application's icon out of a bundle or a `.exe` is
 * actual work that belongs to the wave that schedules it.
 *
 * Until then these report an empty machine and say so through `supports`, so a
 * hub booted on Windows starts, serves, and is honest about the one thing it
 * cannot do — rather than crashing at the first scan and telling a person
 * nothing about why.
 */

const unimplemented = {
  scanInstalled: async () => [],
  icons: async () => undefined,
  autostart: {
    // Nowhere: no file exists that this adapter would write, and `supports`
    // says so out loud, which is why nothing ever draws this answer.
    path: () => "",
    read: async () => false,
    write: async () => {
      throw new Error("Start on boot is not supported on this platform yet.");
    },
  },
  supports: { installedScan: false, icons: false, shortcutCuring: false, autostart: false },
} satisfies Omit<HubPlatform, "id" | "paths">;

/** `~/Library`, where Apple puts each of the three. */
export function macosPaths(
  env: NodeJS.ProcessEnv = process.env,
  app = "mastracode-desktop",
): HubPaths {
  const support = path.join(env.HOME ?? os.homedir(), "Library", "Application Support", app);
  return { config: support, state: path.join(support, "state") };
}

/**
 * `%APPDATA%` and `%LOCALAPPDATA%`.
 *
 * The split is the point: roaming carries a person's settings between machines
 * they sign into, local does not. State and cache stay local — an audit log of
 * what an agent did on one desktop should not follow anyone to another.
 */
export function windowsPaths(
  env: NodeJS.ProcessEnv = process.env,
  app = "mastracode-desktop",
): HubPaths {
  const home = env.USERPROFILE ?? os.homedir();
  const roaming = env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  return { config: path.join(roaming, app), state: path.join(local, app, "state") };
}

export function macosPlatform(env: NodeJS.ProcessEnv = process.env): HubPlatform {
  return { id: "macos", paths: macosPaths(env), ...unimplemented };
}

export function windowsPlatform(env: NodeJS.ProcessEnv = process.env): HubPlatform {
  return { id: "windows", paths: windowsPaths(env), ...unimplemented };
}

/** Which adapter a `process.platform` value asks for. */
export function platformIdFor(platform: NodeJS.Platform): PlatformId {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  // Everything else — Linux, the BSDs, and anything else that ships a desktop
  // — follows the freedesktop conventions.
  return "freedesktop";
}
