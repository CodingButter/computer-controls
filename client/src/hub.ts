import { prepareAgentControllerMount, wireSessionConcerns } from "@mastra/code-sdk";

import type { ClientStatus } from "./app.ts";
import { createAgentTurn } from "./chat.ts";
import type { AgentTurn, HubSession } from "./chat.ts";
import type { ClientConfig } from "./config.ts";
import { registerDesktopPlugin } from "./desktop-plugin.ts";

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
export async function prepareHub(config: ClientConfig) {
  registerDesktopPlugin({
    projectRoot: config.root,
    configDir: config.configDir,
    pluginPath: config.desktopPluginPath,
    scope: config.desktopScope,
  });

  const { base, mastraArgs, finalize } = await prepareAgentControllerMount({
    cwd: config.root,
    configDir: config.configDir,
    // The desktop lives on this machine and the hub runs beside it. There is no
    // sandbox fleet to isolate a session into: isolation here is the daemon's
    // consent ceiling, which is what the plugin's scope configures.
    disableGithubSignals: true,
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

  const chat: AgentTurn = createAgentTurn({
    controller: base.controller,
    getSession,
    modeDefaults: base.effectiveDefaults,
  });

  const status = (): ClientStatus => ({
    tools: Object.keys(base.pluginTools).sort(),
    desktopScope: config.desktopScope,
  });

  return { base, mastraArgs, finalize, chat, status, getSession };
}

export type PreparedHub = Awaited<ReturnType<typeof prepareHub>>;
