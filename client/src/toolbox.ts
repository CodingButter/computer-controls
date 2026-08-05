import { getDynamicWorkspace } from "@mastra/code-sdk/agents/workspace";
import { MC_TOOLS, TOOL_NAME_OVERRIDES } from "@mastra/code-sdk/tool-names";
import { RequestContext } from "@mastra/core/request-context";
import { createSkillTools, createWorkspaceTools, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import type { AnyWorkspace, WorkspaceToolsConfig } from "@mastra/core/workspace";

import type { HubController, HubSession } from "./chat.ts";
import { commonsSkillExtension } from "./skill-commons.ts";

/**
 * The hub rides the coding runtime, and that runtime's default session comes
 * with hands: a shell, file writes, process control. Those hands answer to the
 * runtime's own permission model, not to the desktop daemon's consent ceiling —
 * so a session mounted at "observe" could still open a browser by shelling out
 * instead of asking the daemon, and nothing would appear in the audit log.
 *
 * The rule this module enforces is the same one the daemon applies to its own
 * catalogue: capabilities the ceiling never granted are ABSENT, not disabled.
 * A tool that is merely refused at call time is still a tool the model can see,
 * argue about, and route around. A tool that was never minted is not.
 *
 * The line is effects on the machine. Reading is a workbench; writing,
 * executing, and spawning are hands.
 */

/**
 * Workspace tools the hub's session keeps, keyed by the core names the
 * workspace registers them under and carrying the runtime's own display names
 * so the session sees `view` rather than `mastra_workspace_read_file`.
 *
 * The top-level `enabled: false` is the point: this is an allow-list with a
 * default of deny, so a tool the workspace layer gains in some future release
 * is absent here until somebody admits it deliberately. `lsp_inspect` is not
 * admitted — it reads code, but it reads it by spawning language servers
 * through the sandbox, which is the reach being removed.
 */
export const HUB_WORKSPACE_TOOLS: WorkspaceToolsConfig = {
  enabled: false,
  [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: {
    ...TOOL_NAME_OVERRIDES[WORKSPACE_TOOLS.FILESYSTEM.READ_FILE],
    enabled: true,
  },
  [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: {
    ...TOOL_NAME_OVERRIDES[WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES],
    enabled: true,
  },
  [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: {
    ...TOOL_NAME_OVERRIDES[WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT],
    enabled: true,
  },
  [WORKSPACE_TOOLS.FILESYSTEM.GREP]: {
    ...TOOL_NAME_OVERRIDES[WORKSPACE_TOOLS.FILESYSTEM.GREP],
    enabled: true,
  },
};

/**
 * Names deleted from the runtime's dynamic tool set before the model ever sees
 * it. The workspace allow-list above is what actually keeps these from being
 * minted; this list is the second lock, so a plugin or an extra tool that ever
 * registers itself under one of the runtime's hand-shaped names is deleted
 * rather than inherited.
 */
export const HANDS_OFF_TOOL_NAMES: string[] = [
  MC_TOOLS.WRITE_FILE,
  MC_TOOLS.STRING_REPLACE_LSP,
  MC_TOOLS.DELETE_FILE,
  MC_TOOLS.MKDIR,
  MC_TOOLS.AST_SMART_EDIT,
  MC_TOOLS.EXECUTE_COMMAND,
  MC_TOOLS.GET_PROCESS_OUTPUT,
  MC_TOOLS.KILL_PROCESS,
  MC_TOOLS.LSP_INSPECT,
  ...Object.values(WORKSPACE_TOOLS.FILESYSTEM),
  ...Object.values(WORKSPACE_TOOLS.SANDBOX),
  ...Object.values(WORKSPACE_TOOLS.SEARCH),
  ...Object.values(WORKSPACE_TOOLS.LSP),
].filter((name) => !(name in HUB_WORKSPACE_TOOLS));

/**
 * The workspace the hub's sessions run on: the runtime's own resolution, with
 * the skill commons mounted and the tool catalogue narrowed on the way out.
 *
 * Narrowing has to happen here rather than once at boot because the runtime
 * re-applies its full catalogue to a reused workspace every time it resolves
 * one — a single `setToolsConfig` after boot would be quietly undone by the
 * next session.
 *
 * The commons is passed in rather than found here so that the one place that
 * decides where this hub reads skills from is the boot config. See
 * ./skill-commons.ts for why it is a read-only extension root and not a folder
 * moved under a path the runtime already scans.
 */
export const hubWorkspace = (options: { commonsPath?: string } = {}) => {
  const skillExtension = commonsSkillExtension(options.commonsPath);
  return async (args: {
    requestContext: RequestContext;
    mastra?: Parameters<typeof getDynamicWorkspace>[0]["mastra"];
  }) => {
    const workspace = await getDynamicWorkspace({ ...args, skillExtension });
    workspace.setToolsConfig(HUB_WORKSPACE_TOOLS);
    return workspace;
  };
};

/**
 * Every tool name the session actually holds, from all three places they come
 * from: the runtime's dynamic set (desktop tools, web, inbox), the workspace's
 * catalogue, and the controller's built-ins.
 *
 * Health reports this rather than the plugin catalogue, so the badge a person
 * reads is the toolbox the model was handed.
 */
export async function listSessionTools(deps: {
  controller: HubController;
  session: HubSession;
}): Promise<string[]> {
  const requestContext = new RequestContext();
  const agent = deps.controller.getCurrentAgent(deps.session);
  const workspace = deps.session.getWorkspace() as AnyWorkspace;

  const dynamic = await agent.listTools({ requestContext });
  const workspaceTools = await createWorkspaceTools(workspace, { requestContext, workspace });
  const skillTools = workspace.skills ? createSkillTools(workspace.skills) : {};
  const toolsets = await deps.session.machinery.buildToolsets(requestContext);

  const names = new Set<string>([
    ...Object.keys(dynamic),
    ...Object.keys(workspaceTools),
    ...Object.keys(skillTools),
    ...Object.values(toolsets).flatMap((toolset) => Object.keys(toolset ?? {})),
  ]);
  return [...names].sort();
}
