import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PLUGIN_ALLOWLIST } from "./plugins.ts";

/**
 * Where the hub keeps its state and what it serves.
 *
 * Local mode is the only mode: one process, one port, bound to loopback. There
 * is no auth adapter and no tenant path, so the port is the whole boundary —
 * binding it anywhere but localhost would publish an agent that holds a desktop
 * to the network, and nothing downstream would refuse.
 */
export type ClientConfig = {
  host: string;
  port: number;
  /** Root for project-level config discovery: plugins, hooks, MCP, the database. */
  root: string;
  configDir: string;
  /** Directory holding the desktop-control plugin's package. */
  desktopPluginPath: string;
  /**
   * Operation classes the desktop plugin may mint tools for. Observe by
   * default: the client opens the door from outside before the agent exists,
   * and the honest default opens nothing that changes the desktop.
   */
  desktopScope: string;
  /**
   * Home directory the hub reads this machine's installed plugins from. Read as
   * candidates for the allowlist, never as instructions — see ./plugins.ts.
   */
  pluginHome: string;
  /**
   * Plugin ids the hub will mount. Anything else installed on this machine is
   * refused, and only this boot-time config can extend the list: the agent and
   * the plugins it holds have no say in what else gets mounted beside them.
   */
  pluginAllowlist: string[];
  /** Directory the browser UI is served from. */
  uiRoot: string;
};

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPort(raw: string | undefined): number {
  if (!raw) return 4111;
  const port = Number(raw);
  // 0 is allowed and means "let the OS pick", which is how tests boot the hub
  // without racing a developer's own instance for the default port.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`COMCON_CLIENT_PORT must be a port number, got "${raw}"`);
  }
  return port;
}

/**
 * Extra plugin ids the operator admits, comma-separated.
 *
 * Extends the default list rather than replacing it: the desktop plugin is the
 * reason this hub exists, and an allowlist that could be emptied by an
 * environment variable would be a different feature.
 */
function readAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function resolveClientConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const root = env.COMCON_CLIENT_ROOT ? path.resolve(env.COMCON_CLIENT_ROOT) : packageRoot;
  return {
    host: env.COMCON_CLIENT_HOST ?? "127.0.0.1",
    port: readPort(env.COMCON_CLIENT_PORT),
    root,
    configDir: ".mastracode",
    desktopPluginPath: env.COMCON_DESKTOP_PLUGIN_PATH
      ? path.resolve(env.COMCON_DESKTOP_PLUGIN_PATH)
      : path.resolve(packageRoot, "..", "plugin"),
    desktopScope: env.COMCON_DESKTOP_SCOPE ?? "observe",
    pluginHome: env.COMCON_PLUGIN_HOME ? path.resolve(env.COMCON_PLUGIN_HOME) : os.homedir(),
    pluginAllowlist: [...DEFAULT_PLUGIN_ALLOWLIST, ...readAllowlist(env.COMCON_PLUGIN_ALLOWLIST)],
    uiRoot: path.join(packageRoot, "public"),
  };
}
