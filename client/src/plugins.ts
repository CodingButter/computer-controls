import fs from "node:fs";
import path from "node:path";

import { PluginManager } from "@mastra/code-sdk/plugins/manager";
import { getPluginRoot, getPluginScopePaths } from "@mastra/code-sdk/plugins/paths";
import type { PluginPathOptions } from "@mastra/code-sdk/plugins/paths";
import {
  loadPluginRegistry,
  mergePluginRegistries,
  savePluginRegistry,
} from "@mastra/code-sdk/plugins/registry";
import type {
  InstalledPluginRecord,
  ScopedInstalledPluginRecord,
} from "@mastra/code-sdk/plugins/types";

import { desktopPluginRecord, DESKTOP_PLUGIN_ID } from "./desktop-plugin.ts";
import type { DesktopPluginRegistration } from "./desktop-plugin.ts";

/**
 * Memory, admitted by name.
 *
 * The hub is meant to remember the person using it across sessions, and the
 * plugin that does it is one an operator installs for their own terminal. It is
 * on this list because the product wants it, not because it happened to be
 * installed — which is the whole difference this module exists to make.
 */
export const MEMOREASE_PLUGIN_ID = "memorease";

/** The plugins a hub mounts when the operator configures nothing. */
export const DEFAULT_PLUGIN_ALLOWLIST: readonly string[] = [DESKTOP_PLUGIN_ID, MEMOREASE_PLUGIN_ID];

/** Suffix for the hub's own plugin directory. See {@link mountAllowedPlugins}. */
const HUB_CONFIG_DIR_SUFFIX = "-hub";

/**
 * A directory that is never created, so the manager's global scope is empty.
 *
 * The manager reads two registries and there is no option to read one, so the
 * global one is pointed at a path inside the hub's own directory. An operator
 * installing a plugin for their terminal writes to their home; nothing writes
 * here.
 */
const NO_GLOBAL_SCOPE_DIR = "no-global-scope";

export type PluginAdmission = {
  /** Loads exactly the admitted plugins, and is the manager the runtime mounts. */
  pluginManager: PluginManager;
  /** Ids installed on this machine that the allowlist did not admit. */
  refused: string[];
};

export type PluginAllowlistOptions = {
  projectRoot: string;
  configDir: string;
  /** Home directory whose plugin registry is read for candidates — this machine's operator. */
  homeDir: string;
  allowlist: readonly string[];
  desktop: DesktopPluginRegistration;
};

/**
 * Build the plugin manager the hub mounts: the allowlist, and nothing else.
 *
 * The coding runtime resolves plugins from the project it is pointed at *and*
 * from the operator's home directory, which meant a hub that inherited every
 * plugin on the machine — a personal memory store, an experimental subagent
 * runner, whatever the operator installed for their terminal last week — minted
 * into a session that holds a desktop. None of it was reviewed for that.
 *
 * So the hub stops reading those registries as instructions and starts reading
 * them as candidates. It writes its own registry, under its own config
 * directory, containing exactly the plugins on the allowlist, and hands the
 * runtime a manager pointed there. A plugin that is not on the list is not
 * disabled — it is absent, never loaded, never minted, same as a stripped tool.
 *
 * Admission is not exemption. Plugins that get in still pass the same
 * `HANDS_OFF_TOOL_NAMES` strip on the way to the session: being trusted enough
 * to mount is not being trusted enough to mint a shell.
 */
export function mountAllowedPlugins(options: PluginAllowlistOptions): PluginAdmission {
  const machine: PluginPathOptions = {
    projectRoot: options.projectRoot,
    configDir: options.configDir,
    homeDir: options.homeDir,
  };

  const candidates: ScopedInstalledPluginRecord[] = [
    ...mergePluginRegistries(
      loadPluginRegistry(getPluginScopePaths("global", machine).registryPath),
      loadPluginRegistry(getPluginScopePaths("project", machine).registryPath),
    ),
    // Minted last so it wins over any stale record for the same id: the desktop
    // plugin the hub mounts is the one this process was configured with.
    { id: DESKTOP_PLUGIN_ID, scope: "project", ...desktopPluginRecord(options.desktop) },
  ];

  const allowed = new Set(options.allowlist);
  const admitted = new Map<string, ScopedInstalledPluginRecord>();
  const refused = new Set<string>();
  for (const candidate of candidates) {
    if (allowed.has(candidate.id)) admitted.set(candidate.id, candidate);
    else refused.add(candidate.id);
  }

  const hub = hubPaths(options);
  const { root, registryPath } = getPluginScopePaths("project", hub);
  fs.mkdirSync(root, { recursive: true });
  // Written whole rather than merged: the file is derived state, and a record
  // left behind by a previous boot is a plugin the operator may have since
  // uninstalled or the allowlist may have since dropped.
  savePluginRegistry(registryPath, {
    plugins: Object.fromEntries(
      [...admitted].map(([id, record]) => [id, mountableRecord(record, machine)]),
    ),
    // An operator who disabled a plugin for themselves gets that honoured here
    // too. Being on the allowlist is permission to mount, not an instruction to.
    disabledPlugins: [...admitted.values()]
      .filter((record) => record.blocked)
      .map((record) => record.id)
      .sort(),
  });

  return { pluginManager: new PluginManager(hub), refused: [...refused].sort() };
}

/** The hub's own plugin scope: beside the operator's config directory, never inside it. */
function hubPaths(options: PluginAllowlistOptions): PluginPathOptions {
  const configDir = `${options.configDir}${HUB_CONFIG_DIR_SUFFIX}`;
  return {
    projectRoot: options.projectRoot,
    configDir,
    homeDir: path.join(options.projectRoot, configDir, NO_GLOBAL_SCOPE_DIR),
  };
}

/**
 * Re-address a candidate record so it resolves from the hub's registry.
 *
 * Paths in a registry are relative to the scope that holds them, so a record
 * copied across scopes has to be made absolute against the scope it came from
 * or it would point at a directory that does not exist. The source becomes
 * `local` for the same reason: `github` records must live inside their own
 * scope's directory, and the hub mounts a checkout it does not own. It also
 * means the hub never fetches or updates plugin code — it mounts what is
 * already on the disk, and updating stays the operator's business.
 */
function mountableRecord(
  record: ScopedInstalledPluginRecord,
  machine: PluginPathOptions,
): InstalledPluginRecord {
  return {
    enabled: record.enabled,
    source: "local",
    specifier: record.specifier,
    path: path.resolve(getPluginRoot(record.scope, machine), record.path),
    entry: record.entry,
    ...(record.version === undefined ? {} : { version: record.version }),
    ...(record.config === undefined ? {} : { config: record.config }),
  };
}
