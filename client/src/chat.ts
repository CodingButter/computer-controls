import { runMC } from "@mastra/code-sdk";
import type { MastraCodeAgentController } from "@mastra/code-sdk";

export type HubController = MastraCodeAgentController["controller"];
export type HubSession = Awaited<ReturnType<HubController["createSession"]>>;

export type ChatRequest = {
  message: string;
  threadId?: string;
};

export type ChatReply = {
  text: string;
  threadId?: string;
  status: string;
};

/** One turn of conversation: a message goes in, the agent's answer comes back. */
export type AgentTurn = (request: ChatRequest) => Promise<ChatReply>;

export type AgentTurnDeps = {
  controller: HubController;
  /** The session this browser's turns run through. Resolved per turn so it can be minted lazily. */
  getSession: () => Promise<HubSession>;
  /** Execution mode for the turn. */
  mode?: "build" | "plan" | "fast";
  /**
   * The model the turn runs on, named rather than inferred. Without it the
   * runner resolves a model from the mode's defaults, and those defaults are
   * the runtime's to decide — see ./model-pack.ts for why this hub decides
   * instead.
   */
  model: string;
  /**
   * The headless runner. Injected so the wiring can be proved without a model:
   * everything from the HTTP body to the runner options and back to the reply
   * is this module's code, and only the model call belongs to the SDK.
   */
  run?: typeof runMC;
};

export function createAgentTurn(deps: AgentTurnDeps): AgentTurn {
  const run = deps.run ?? runMC;
  return async (request) => {
    const session = await deps.getSession();
    const result = await run({
      controller: deps.controller,
      session,
      prompt: request.message,
      mode: deps.mode ?? "build",
      model: deps.model,
      ...(request.threadId ? { thread: { id: request.threadId } } : {}),
    }).result;

    return {
      text: result.text,
      threadId: result.threadId,
      status: result.status,
    };
  };
}
