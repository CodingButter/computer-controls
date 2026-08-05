import path from "node:path";

import type { HubPaths } from "./platform/index.ts";

/**
 * The two files the hub shares with the daemon, named once.
 *
 * The directory is the platform adapter's business — XDG on freedesktop,
 * `~/Library` on macOS, the roaming/local split on Windows — and the filename
 * is the protocol's: `config.json` and `audit.jsonl` are what the daemon writes
 * (`service/desktop_service/config.py`, `audit.py`), so the hub cannot invent
 * its own spelling without reading a file nobody writes.
 *
 * Both halves live here rather than in each consumer because four modules used
 * to resolve these paths independently, and four copies of "XDG_CONFIG_HOME,
 * else ~/.config" is four chances to disagree with the process on the other end
 * of the socket.
 */
export function configFile(paths: HubPaths): string {
  return path.join(paths.config, "config.json");
}

export function auditFile(paths: HubPaths): string {
  return path.join(paths.state, "audit.jsonl");
}
