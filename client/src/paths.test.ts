import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { auditFile, configFile } from "./paths.ts";
import { resolveHubPlatform } from "./platform/index.ts";

const freedesktop = (env: NodeJS.ProcessEnv) => resolveHubPlatform(env, "linux").paths;

describe("the two files the hub shares with the daemon", () => {
  it("names them the way the daemon writes them", () => {
    const paths = freedesktop({ XDG_CONFIG_HOME: "/tmp/xdg", XDG_STATE_HOME: "/tmp/state" });

    expect(configFile(paths)).toBe("/tmp/xdg/mastracode-desktop/config.json");
    expect(auditFile(paths)).toBe("/tmp/state/mastracode-desktop/audit.jsonl");
  });

  it("falls back to the XDG defaults config.py and audit.py fall back to", () => {
    const paths = freedesktop({});

    expect(configFile(paths)).toBe(
      path.join(os.homedir(), ".config", "mastracode-desktop", "config.json"),
    );
    expect(auditFile(paths)).toBe(
      path.join(os.homedir(), ".local", "state", "mastracode-desktop", "audit.jsonl"),
    );
  });

  it("follows the platform rather than the environment, so a mac hub is not XDG", () => {
    const paths = resolveHubPlatform({ HOME: "/Users/someone" }, "darwin").paths;

    expect(configFile(paths)).toBe(
      "/Users/someone/Library/Application Support/mastracode-desktop/config.json",
    );
  });
});
