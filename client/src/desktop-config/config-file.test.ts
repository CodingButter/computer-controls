import { open, mkdtemp, readFile, rm, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MalformedConfig,
  OPERATION_CLASSES,
  PERMISSIONS_MODES,
  SETTINGS_KEYS,
  defaultConfigPath,
  mergeSettings,
  readConfigFile,
  writeConfigFile,
} from "./config-file.ts";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "desktop-config-"));
  file = path.join(dir, "config.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("where the daemon looks", () => {
  it("follows XDG_CONFIG_HOME, the way config.py does", () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" } as NodeJS.ProcessEnv)).toBe(
      "/tmp/xdg/mastracode-desktop/config.json",
    );
  });

  it("falls back to ~/.config when it is unset", () => {
    expect(defaultConfigPath({} as NodeJS.ProcessEnv)).toBe(
      path.join(os.homedir(), ".config", "mastracode-desktop", "config.json"),
    );
  });
});

describe("reading", () => {
  it("treats a missing file as the safe default rather than an error", async () => {
    expect(await readConfigFile(file)).toEqual({ config: {}, exists: false });
  });

  it("refuses invalid JSON by name instead of reading it as empty", async () => {
    await writeFile(file, '{"scopes": {"idleExpirySeconds": 60,}}');
    await expect(readConfigFile(file)).rejects.toThrow(MalformedConfig);
    await expect(readConfigFile(file)).rejects.toThrow(/is not valid JSON/);
  });

  it("refuses a document that is not an object", async () => {
    await writeFile(file, "[1, 2, 3]");
    await expect(readConfigFile(file)).rejects.toThrow(/must contain a JSON object/);
  });
});

describe("owning only what it edits", () => {
  it("leaves the per-application registry alone when the ceiling mode changes", () => {
    const existing = {
      scopes: {
        permissionsMode: "open",
        applications: ["discord", "nautilus"],
        blockedApplications: ["bitwarden", "keepassxc"],
      },
    };
    const merged = mergeSettings(existing, { "scopes.permissionsMode": "per-application" });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.config).toEqual({
      scopes: {
        permissionsMode: "per-application",
        applications: ["discord", "nautilus"],
        blockedApplications: ["bitwarden", "keepassxc"],
      },
    });
  });

  it("carries through a key it has never been taught about, at any depth", () => {
    const existing = {
      scopes: { idleExpirySeconds: 60, somethingFromANewerVersion: { deep: [1, 2] } },
      aTopLevelKeyWeDoNotKnow: "kept",
    };
    const merged = mergeSettings(existing, { "scopes.idleExpirySeconds": 900 });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.config).toEqual({
      scopes: { idleExpirySeconds: 900, somethingFromANewerVersion: { deep: [1, 2] } },
      aTopLevelKeyWeDoNotKnow: "kept",
    });
  });

  it("refuses an edit to a key it does not own rather than silently dropping it", () => {
    const merged = mergeSettings({}, { "scopes.applications": ["discord"] });
    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.reason).toMatch(/not a setting this page owns/);
  });

  it("does not claim the permissions registry as its own", () => {
    expect(SETTINGS_KEYS).not.toContain("scopes.applications");
    expect(SETTINGS_KEYS).not.toContain("scopes.blockedApplications");
  });

  it("creates the branch when writing a nested setting into an empty config", () => {
    const merged = mergeSettings({}, { "scopes.operationClasses": ["observe", "edit"] });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.config).toEqual({ scopes: { operationClasses: ["observe", "edit"] } });
  });
});

describe("never writing a file the daemon would refuse", () => {
  it("refuses a misspelled permissions mode", () => {
    const merged = mergeSettings({}, { "scopes.permissionsMode": "per application" });
    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.reason).toMatch(/permissionsMode must be one of open, per-application/);
  });

  it("normalises a mode the way security.py does before storing it", () => {
    const merged = mergeSettings({}, { "scopes.permissionsMode": "  Per-Application " });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.config).toEqual({ scopes: { permissionsMode: "per-application" } });
  });

  it("refuses an operation class outside the frozen vocabulary", () => {
    const merged = mergeSettings({}, { "scopes.operationClasses": ["observe", "teleport"] });
    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.reason).toMatch(/unknown operation class/);
  });

  it("holds the same vocabulary the protocol froze", () => {
    expect([...OPERATION_CLASSES]).toEqual([
      "observe",
      "edit",
      "activate",
      "submit",
      "destructive",
    ]);
    expect([...PERMISSIONS_MODES]).toEqual(["open", "per-application"]);
  });

  it("refuses a negative idle expiry", () => {
    expect(mergeSettings({}, { "scopes.idleExpirySeconds": -1 }).ok).toBe(false);
  });

  it("refuses a non-boolean audit flag", () => {
    expect(mergeSettings({}, { audit: "yes" }).ok).toBe(false);
  });
});

describe("writing", () => {
  it("replaces the file rather than truncating it in place", async () => {
    await writeConfigFile(file, { audit: true });
    // A reader that opened the old file keeps reading the old bytes only if the
    // new contents arrived as a new inode renamed over the name. An in-place
    // rewrite would show this handle the new bytes, or a torn prefix of them —
    // which is exactly what the daemon's per-request stat would race with.
    const held = await open(file, "r");
    try {
      await writeConfigFile(file, { audit: false });
      expect(JSON.parse((await held.readFile("utf8")) as string)).toEqual({ audit: true });
    } finally {
      await held.close();
    }
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ audit: false });
  });

  it("leaves no temporary files behind", async () => {
    await writeConfigFile(file, { audit: true });
    await writeConfigFile(file, { audit: false });
    expect(await readdir(dir)).toEqual(["config.json"]);
  });

  it("writes the file only the user can read", async () => {
    await writeConfigFile(file, { audit: true });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("creates the config directory on a machine that has never had one", async () => {
    const nested = path.join(dir, "mastracode-desktop", "config.json");
    await writeConfigFile(nested, { audit: true });
    expect(JSON.parse(await readFile(nested, "utf8"))).toEqual({ audit: true });
  });
});
