import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MC_TOOLS } from "@mastra/code-sdk/tool-names";
import { Mastra } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import { createWorkspaceTools, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import type { AnyWorkspace } from "@mastra/core/workspace";
import { afterAll, beforeAll, expect, test } from "vitest";

import desktopControl from "../../clients/mastra-plugin/src/index.ts";
import { buildApp } from "./app.ts";
import type { HubController, HubSession } from "./chat.ts";
import { resolveClientConfig } from "./config.ts";
import { prepareHub } from "./hub.ts";
import { listSessionTools } from "./toolbox.ts";

/**
 * The hub's session, booted for real, asked what it is holding.
 *
 * The session here is the one the browser's chat turns land on — same
 * controller, same workspace, same catalogue. Nothing below is asserted against
 * a reconstruction of the toolbox; every list is read off the running session.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "comcon-toolbox-"));

let hub: Awaited<ReturnType<typeof prepareHub>>;
let controller: HubController;
let session: HubSession;
let app: ReturnType<typeof buildApp>;
let tools: string[];

/** Every name for a capability that changes this machine, in both vocabularies. */
const HANDS: string[] = [
  MC_TOOLS.WRITE_FILE,
  MC_TOOLS.STRING_REPLACE_LSP,
  MC_TOOLS.DELETE_FILE,
  MC_TOOLS.MKDIR,
  MC_TOOLS.AST_SMART_EDIT,
  MC_TOOLS.EXECUTE_COMMAND,
  MC_TOOLS.GET_PROCESS_OUTPUT,
  MC_TOOLS.KILL_PROCESS,
  MC_TOOLS.LSP_INSPECT,
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
  WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
  WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT,
  WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS,
  WORKSPACE_TOOLS.LSP.LSP_INSPECT,
];

beforeAll(async () => {
  const config = resolveClientConfig({ ...process.env, COMCON_CLIENT_ROOT: root });
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
});

test("test_the_hub_session_holds_no_shell_and_no_file_write_tools", async () => {
  for (const name of HANDS) expect(tools).not.toContain(name);

  // Absence has to be checked where the tools are minted, not only in the name
  // list: a tool that exists but is refused at call time is still a tool the
  // model can see and argue with. The workspace catalogue this session runs on
  // is the read-only bench and nothing else.
  const workspace = session.getWorkspace() as AnyWorkspace;
  const requestContext = new RequestContext();
  const minted = await createWorkspaceTools(workspace, { requestContext, workspace });
  expect(Object.keys(minted).sort()).toEqual([
    MC_TOOLS.FILE_STAT,
    MC_TOOLS.FIND_FILES,
    MC_TOOLS.SEARCH_CONTENT,
    MC_TOOLS.VIEW,
  ]);

  // The bench survived the strip — reading hub-served content is not the thing
  // being taken away.
  for (const name of Object.keys(minted)) expect(tools).toContain(name);
});

test("test_the_health_toolbox_is_the_session_toolbox", async () => {
  const response = await app.request("/api/health");
  const health = (await response.json()) as { tools: string[] };

  // Not "a toolbox shaped like the session's" — the session's, read again from
  // the live objects at assertion time.
  expect(health.tools).toEqual(await listSessionTools({ controller, session }));
  for (const name of HANDS) expect(health.tools).not.toContain(name);

  // And it is no longer the plugin catalogue wearing the session's name. The
  // plugin's tools are in there, but so is everything else the model holds,
  // which is what makes the badge worth reading.
  const pluginTools = Object.keys(hub.base.pluginTools).sort();
  expect(pluginTools.length).toBeGreaterThan(0);
  for (const name of pluginTools) expect(health.tools).toContain(name);
  expect(health.tools.length).toBeGreaterThan(pluginTools.length);
});

test("test_a_request_to_run_a_command_is_refused_not_executed", async () => {
  const workspace = session.getWorkspace() as AnyWorkspace;
  const sentinel = path.join(root, "shelled-out");

  // The shell underneath is real and unguarded: nothing about this hub removes
  // the machine's ability to run a command. That is what makes the absence
  // below worth asserting rather than a tautology about an inert workspace.
  const executeCommand = workspace.sandbox?.executeCommand;
  expect(executeCommand).toBeTypeOf("function");
  await executeCommand!.call(workspace.sandbox, "touch", [sentinel]);
  expect(fs.existsSync(sentinel)).toBe(true);
  fs.rmSync(sentinel);

  // The session's only way to reach it would be a tool with one of these names,
  // and the model can only call tools by exact name. There is no entry to call,
  // so the request ends at the lookup — above the shell, not at it.
  const reachable = tools.filter((name) => HANDS.includes(name));
  expect(reachable).toEqual([]);
  expect(fs.existsSync(sentinel)).toBe(false);
});

test("test_desktop_tools_survive_the_stripping_at_every_scope", async () => {
  // The strip is name-based, so the way it could eat the desktop lane is by
  // sharing a name with it. Ask the plugin for its catalogue at every scope it
  // can be mounted at and check the two vocabularies never collide.
  for (const scope of ["observe", "observe,edit", "observe,edit,activate,submit,destructive"]) {
    const minted = await mintedAt(scope);
    expect(minted.length).toBeGreaterThan(0);
    for (const name of minted) expect(HANDS).not.toContain(name);
  }

  // At the scope this hub actually mounts, the survival is observed rather than
  // reasoned about: every tool the plugin minted is in the session's hand.
  const observeTools = await mintedAt("observe");
  for (const name of observeTools) expect(tools).toContain(name);
});

async function mintedAt(scope: string): Promise<string[]> {
  const pluginDir = path.resolve(import.meta.dirname, "..", "..", "clients", "mastra-plugin");
  const minted = await desktopControl.tools({
    cwd: pluginDir,
    scope: "project",
    pluginDir,
    config: { scope },
  });
  return Object.keys(minted).sort();
}
