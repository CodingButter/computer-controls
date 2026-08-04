import fs from "node:fs";
import path from "node:path";

import type { InstalledPluginRecord } from "@mastra/code-sdk/plugins/types";

export const DESKTOP_PLUGIN_ID = "desktop-control";

const ENTRY = "src/index.ts";

export type DesktopPluginRegistration = {
  pluginPath: string;
  scope: string;
};

/**
 * The registry record that mounts the desktop plugin at the configured
 * operation scope.
 *
 * This mints the record rather than calling `PluginManager.installLocal`
 * deliberately: install links a `mastracode` package into the plugin directory
 * for TUI-installed plugins, and that package is not a dependency of this hub.
 * The plugin already lives in this repository beside us — there is nothing to
 * fetch, and the registry record is the entire installation.
 *
 * The record is built on every boot, so the door the agent finds is the one
 * this process configured and not one a previous run left open. Where it gets
 * written is `./plugins.ts`'s business: the desktop plugin is admitted the same
 * way every other plugin is, by being on the allowlist.
 */
export function desktopPluginRecord(
  registration: DesktopPluginRegistration,
): InstalledPluginRecord {
  const pluginPath = path.resolve(registration.pluginPath);
  const entryPath = path.join(pluginPath, ENTRY);
  if (!fs.existsSync(entryPath)) {
    throw new Error(
      `Desktop plugin entry not found at ${entryPath}. ` +
        `Set COMCON_DESKTOP_PLUGIN_PATH to the directory holding the plugin package.`,
    );
  }

  return {
    enabled: true,
    source: "local",
    specifier: pluginPath,
    path: pluginPath,
    entry: ENTRY,
    config: { scope: registration.scope },
  };
}
