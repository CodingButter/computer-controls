import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getPluginScopePaths } from "@mastra/code-sdk/plugins/paths";
import { savePluginRegistry } from "@mastra/code-sdk/plugins/registry";
import type { LoadedPlugin } from "@mastra/code-sdk/plugins/types";
import { MC_TOOLS } from "@mastra/code-sdk/tool-names";
import { Mastra } from "@mastra/core/mastra";
import { afterAll, beforeAll, expect, test } from "vitest";

import { buildApp } from "./app.ts";
import type { HubController, HubSession } from "./chat.ts";
import { resolveClientConfig } from "./config.ts";
import { DESKTOP_PLUGIN_ID } from "./desktop-plugin.ts";
import { prepareHub } from "./hub.ts";
import handsy from "./plugin-fixtures/handsy/index.ts";
import memorease from "./plugin-fixtures/memorease/index.ts";
import uninvited from "./plugin-fixtures/uninvited/index.ts";
import { DEFAULT_PLUGIN_ALLOWLIST } from "./plugins.ts";
import { listSessionTools } from "./toolbox.ts";

/**
 * The hub booted for real on a machine that has plugins installed on it.
 *
 * The operator's home here is a temporary directory holding a registry with
 * three loadable plugins in it — the shape the coding runtime resolves plugins
 * from, and the shape that used to hand this session everything the operator
 * ever installed. Nothing below asks the allowlist what it decided; every
 * assertion is read off the running session or the manager that loaded it.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "comcon-plugins-root-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "comcon-plugins-home-"));

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "plugin-fixtures");

/** On the allowlist by operator config, plus one that is not installed at all. */
const OPERATOR_ALLOWLIST = "handsy,ghost";

let hub: Awaited<ReturnType<typeof prepareHub>>;
let controller: HubController;
let session: HubSession;
let app: ReturnType<typeof buildApp>;
let tools: string[];

function loadedPlugins(): LoadedPlugin[] {
  return hub.base.pluginManager?.getLoadedPlugins() ?? [];
}

beforeAll(async () => {
  const registryPath = getPluginScopePaths("global", {
    projectRoot: root,
    configDir: ".mastracode",
    homeDir: home,
  }).registryPath;
  savePluginRegistry(registryPath, {
    plugins: Object.fromEntries(
      ["memorease", "uninvited", "handsy"].map((id) => [
        id,
        {
          enabled: true,
          source: "local" as const,
          specifier: path.join(fixtures, id),
          path: path.join(fixtures, id),
          entry: "index.ts",
        },
      ]),
    ),
  });

  const config = resolveClientConfig({
    ...process.env,
    COMCON_CLIENT_ROOT: root,
    COMCON_PLUGIN_HOME: home,
    COMCON_PLUGIN_ALLOWLIST: OPERATOR_ALLOWLIST,
  });
  hub = await prepareHub(config);
  controller = hub.base.controller;
  new Mastra(hub.mastraArgs);
  await hub.finalize();

  session = await hub.getSession();
  app = buildApp({ chat: hub.chat, uiRoot: config.uiRoot, status: hub.status });
  tools = await listSessionTools({ controller, session });
}, 120_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("test_a_plugin_that_is_not_on_the_allowlist_is_not_mounted", () => {
  // The plugin is real and would have loaded: it exports a tool the session
  // would be holding right now if the hub had inherited it the way it used to.
  const [toolName] = Object.keys(uninvited.tools);
  expect(toolName).toBe("uninvited_probe");
  expect(uninvited.id).not.toBe(DESKTOP_PLUGIN_ID);

  // It is absent rather than disabled: no loaded record, no tool in the
  // catalogue the runtime built, no name in the session's hand. There is
  // nothing to enable.
  expect(loadedPlugins().map((plugin) => plugin.id)).not.toContain(uninvited.id);
  expect(Object.keys(hub.base.pluginTools)).not.toContain(toolName);
  expect(tools).not.toContain(toolName);
});

test("test_memorease_is_mounted_by_default_and_its_tools_reach_the_session", () => {
  // Admitted by the built-in list, not by this boot's operator config — memory
  // is in the product, so the hub carries it without being asked.
  expect(DEFAULT_PLUGIN_ALLOWLIST).toContain(memorease.id);
  expect(OPERATOR_ALLOWLIST.split(",")).not.toContain(memorease.id);

  const loaded = loadedPlugins().find((plugin) => plugin.id === memorease.id);
  expect(loaded?.status).toBe("active");
  expect(tools).toContain("memorease_probe");
});

test("test_an_allowed_plugin_cannot_mint_a_tool_the_ceiling_strips", () => {
  // Admitted, and reaching for a shell on the way in.
  expect(Object.keys(handsy.tools)).toContain(MC_TOOLS.EXECUTE_COMMAND);
  expect(loadedPlugins().find((plugin) => plugin.id === handsy.id)?.status).toBe("active");
  expect(tools).toContain("handsy_probe");

  // The plugin minted it and the runtime took it back off: being on the
  // allowlist buys a mount, not an exemption from the ceiling.
  expect(loadedPlugins().find((plugin) => plugin.id === handsy.id)?.toolNames).toContain(
    MC_TOOLS.EXECUTE_COMMAND,
  );
  expect(tools).not.toContain(MC_TOOLS.EXECUTE_COMMAND);
});

test("test_health_reports_the_plugins_it_admitted_and_the_ones_it_refused", async () => {
  const response = await app.request("/api/health");
  const health = (await response.json()) as {
    plugins: { admitted: string[]; refused: string[] };
  };

  // Admitted is the manager's own list, read again at assertion time rather
  // than the intention the hub started the boot with.
  expect(health.plugins.admitted).toEqual([DESKTOP_PLUGIN_ID, handsy.id, memorease.id].sort());
  expect(health.plugins.admitted).toEqual(
    loadedPlugins()
      .map((plugin) => plugin.id)
      .sort(),
  );

  // Refused says "found and turned away", which is the fact a person needs when
  // a tool they expected is missing.
  expect(health.plugins.refused).toEqual([uninvited.id]);

  // And a plugin nobody installed appears in neither list, so "not installed"
  // never reads as "declined".
  expect(health.plugins.admitted).not.toContain("ghost");
  expect(health.plugins.refused).not.toContain("ghost");
});
