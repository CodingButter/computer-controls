import fs from "node:fs";
import path from "node:path";

import { getPluginScopePaths } from "@mastra/code-sdk/plugins/paths";
import {
  loadPluginRegistry,
  savePluginRegistry,
  setPluginRecord,
} from "@mastra/code-sdk/plugins/registry";

export const DESKTOP_PLUGIN_ID = "desktop-control";

const ENTRY = "src/index.ts";

export type DesktopPluginRegistration = {
  projectRoot: string;
  configDir: string;
  pluginPath: string;
  scope: string;
};

/**
 * Put the desktop plugin in the project registry Mastra Code reads at boot, at
 * the configured operation scope.
 *
 * This writes the record rather than calling `PluginManager.installLocal`
 * deliberately: install links a `mastracode` package into the plugin directory
 * for TUI-installed plugins, and that package is not a dependency of this hub.
 * The plugin already lives in this repository beside us — there is nothing to
 * fetch, and the registry record is the entire installation.
 *
 * The scope is written on every boot, so the door the agent finds is the one
 * this process configured and not one a previous run left open.
 */
export function registerDesktopPlugin(registration: DesktopPluginRegistration): string {
  const pluginPath = path.resolve(registration.pluginPath);
  const entryPath = path.join(pluginPath, ENTRY);
  if (!fs.existsSync(entryPath)) {
    throw new Error(
      `Desktop plugin entry not found at ${entryPath}. ` +
        `Set COMCON_DESKTOP_PLUGIN_PATH to the directory holding the plugin package.`,
    );
  }

  const { root, registryPath } = getPluginScopePaths("project", {
    projectRoot: registration.projectRoot,
    configDir: registration.configDir,
  });
  fs.mkdirSync(root, { recursive: true });

  savePluginRegistry(
    registryPath,
    setPluginRecord(loadPluginRegistry(registryPath), DESKTOP_PLUGIN_ID, {
      enabled: true,
      source: "local",
      specifier: pluginPath,
      path: pluginPath,
      entry: ENTRY,
      config: { scope: registration.scope },
    }),
  );

  return registryPath;
}
