import path from "node:path";

import { prepareAgentControllerMount, wireSessionConcerns } from "@mastra/code-sdk";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";

import type { ClientStatus } from "./app.ts";
import { createAgentTurn } from "./chat.ts";
import type { AgentTurn, HubSession } from "./chat.ts";
import type { ClientConfig } from "./config.ts";
import {
  hubModes,
  MODE_BRAINS,
  modelForTier,
  resolveModelPack,
  THINKING_MODE,
  type ModelPack,
} from "./model-pack.ts";
import { mountAllowedPlugins } from "./plugins.ts";
import { createConfigSubagent } from "./settings/agent.ts";
import type { SettingsGate } from "./settings/gate.ts";
import { HANDS_OFF_TOOL_NAMES, hubWorkspace, listSessionTools } from "./toolbox.ts";

/** The browser is one caller, so its turns share one session and one thread history. */
const BROWSER_RESOURCE_ID = "local-browser";

/**
 * Everything the hub needs to exist, assembled but not constructed.
 *
 * The split matches how Factory boots: `prepare` resolves dependencies and
 * returns constructor args, the caller runs the `new Mastra(...)` literal in
 * its own module, and `finalize` does the post-construct boot. Keeping the
 * literal in the entry module is not cosmetic — the deployer's Babel plugin
 * only recognises a Mastra config when it finds that expression there.
 */
export interface PrepareHubOptions {
  /**
   * The settings door, when the caller has assembled one.
   *
   * Optional because the settings service needs a credential store, and the
   * hub is prepared before that store exists — the entry module builds both and
   * hands this back down. A hub prepared without it simply has no configuration
   * agent: the tools are absent rather than present and refusing, which is the
   * same rule the desktop tools follow.
   */
  settings?: SettingsGate;

  /**
   * Told about every controller event of every turn.
   *
   * The touch lane is what this exists for: a face draws where the agent's
   * hands are, and the hands belong to the hub rather than to whichever surface
   * started the turn. Optional, and a hub without one behaves exactly as it did
   * before — which is what every test that does not care about faces boots.
   */
  observe?: (event: AgentControllerEvent) => void;

  /**
   * The pack a person picked on the Models page, asked once per turn.
   *
   * A function rather than a value because the whole point of choosing a pack
   * from a page is that the choice outlives the click: reading it here means the
   * next thing said in the browser runs on the new brain, without a restart.
   * Absent — as in every test that does not care — leaves the declared pack
   * standing, which is exactly how this hub behaved before the page existed.
   */
  activePack?: () => ModelPack;
}

export async function prepareHub(config: ClientConfig, options: PrepareHubOptions = {}) {
  // Before anything is constructed, because a pack that cannot be resolved is a
  // hub that would otherwise boot and think with somebody else's pick.
  const modelPack = resolveModelPack();

  const { pluginManager, refused } = mountAllowedPlugins({
    projectRoot: config.root,
    configDir: config.configDir,
    homeDir: config.pluginHome,
    allowlist: config.pluginAllowlist,
    desktop: { pluginPath: config.desktopPluginPath, scope: config.desktopScope },
  });

  const { base, mastraArgs, finalize } = await prepareAgentControllerMount({
    cwd: config.root,
    configDir: config.configDir,
    // The modes a session can enter, each carrying the model this repository
    // declared rather than one the runtime resolved for it. See ./model-pack.ts.
    modes: hubModes(modelPack),
    // Which only holds if the runtime is not reading a settings file that says
    // otherwise: a saved model choice in the TUI's settings is stamped over a
    // configured mode default, so the hub keeps its own file under its own root
    // instead of inheriting the preferences of whoever last used the TUI on this
    // machine. Credentials are a separate store and are still shared.
    settingsPath: path.join(config.root, config.configDir, "settings.json"),
    // The desktop lives on this machine and the hub runs beside it. There is no
    // sandbox fleet to isolate a session into: isolation here is the daemon's
    // consent ceiling, which is what the plugin's scope configures.
    disableGithubSignals: true,
    // Which is why the coding runtime's hands come off. The daemon is the only
    // door onto this machine that the hub is allowed to knock on; a shell, a
    // file write, or a language-server spawn would be a second door, opening
    // without a scope check and without an audit line. See ./toolbox.ts.
    workspace: hubWorkspace({ commonsPath: config.commonsPath }),
    disabledTools: HANDS_OFF_TOOL_NAMES,
    // Left to itself the runtime resolves plugins from this project *and* from
    // the operator's home directory, which handed a session that holds a
    // desktop every plugin the operator ever installed for their terminal. This
    // manager loads the allowlist and nothing else. See ./plugins.ts.
    pluginManager,
    // Both of these read this machine's coding-agent config and turn it into
    // effects: MCP servers mint tools of unknown reach, hooks run shell
    // commands around tool calls. Neither passes through the daemon, so
    // neither belongs to a session mounted at an observe-shaped scope.
    disableMcp: true,
    disableHooks: true,
    // The configuration agent, and nothing else. The runtime's own subagent
    // list defaults to empty, so this is the whole set: one mind that can
    // change settings and cannot touch the desktop, beside one that holds the
    // desktop and cannot change settings. See ./settings/agent.ts.
    subagents: options.settings
      ? [
          createConfigSubagent({
            gate: options.settings,
            surface: "conversation",
            modelId: modelForTier(modelPack, "standard"),
          }),
        ]
      : [],
  });

  let pending: Promise<HubSession> | undefined;
  const getSession = (): Promise<HubSession> => {
    pending ??= mintSession();
    return pending;
  };

  async function mintSession(): Promise<HubSession> {
    const existing = await base.controller.getSessionByResource(BROWSER_RESOURCE_ID);
    const session =
      existing ?? (await base.controller.createSession({ resourceId: BROWSER_RESOURCE_ID }));
    await wireSessionConcerns(base, session);
    return session;
  }

  /**
   * The model the browser's turns run on.
   *
   * Named on the turn itself, not left to the mode's default, because the
   * runtime stamps this machine's saved settings over a configured mode model
   * whenever that file happens to hold one. A turn that names its model is the
   * one place the chain cannot be re-entered: declaring the pack on the modes
   * says what this hub runs, and naming it here makes it so.
   */
  const currentPack = (): ModelPack => options.activePack?.() ?? modelPack;
  const thinkingModel = (): string => modelForTier(currentPack(), MODE_BRAINS[THINKING_MODE]);

  const chat: AgentTurn = createAgentTurn({
    controller: base.controller,
    getSession,
    mode: THINKING_MODE,
    model: thinkingModel,
    ...(options.observe ? { observe: options.observe } : {}),
  });

  /**
   * Health answers with the toolbox the session is actually holding, minting
   * the session if the browser has not spoken yet. Reporting the plugin
   * catalogue instead would have made the badge a description of what was
   * mounted rather than of what the model can reach — which is exactly the gap
   * a stripped session has to be able to prove closed.
   *
   * It answers with the brain on the same terms: the pack that was declared,
   * the model a turn will actually reach for, and what each tier resolves to —
   * so "which model holds the desktop" is a question with an answer anyone can
   * fetch, instead of one that has to be measured on a live boot.
   */
  const status = async (): Promise<ClientStatus> => ({
    tools: await listSessionTools({ controller: base.controller, session: await getSession() }),
    desktopScope: config.desktopScope,
    plugins: {
      // Read off the manager rather than from the admission decision: what was
      // asked for and what loaded are different facts, and only the second one
      // is worth reporting. Refusals have no loaded record to read, so they
      // come from the decision itself — a plugin missing from both lists is one
      // that is not installed on this machine at all.
      admitted: (base.pluginManager?.getLoadedPlugins() ?? []).map((plugin) => plugin.id).sort(),
      refused,
    },
    model: {
      // The pack answering right now rather than the one this process booted
      // with, so a page that says it switched can be checked against health.
      pack: currentPack().id,
      thinking: thinkingModel(),
      tiers: currentPack().models,
    },
    // Which OS adapter booted, and what it admits it cannot do. Reported
    // because the adapters for the unscheduled OSes answer "nothing installed"
    // rather than throwing, and a person on one of those deserves to be told
    // the difference between an empty desktop and an unwritten scanner.
    platform: { id: config.platform.id, supports: config.platform.supports },
  });

  return { base, mastraArgs, finalize, chat, status, getSession, modelPack };
}

export type PreparedHub = Awaited<ReturnType<typeof prepareHub>>;
