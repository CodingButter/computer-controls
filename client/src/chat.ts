import { runMC } from "@mastra/code-sdk";
import type { MastraCodeAgentController } from "@mastra/code-sdk";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";

export type HubController = MastraCodeAgentController["controller"];
export type HubSession = Awaited<ReturnType<HubController["createSession"]>>;

export type ChatRequest = {
  message: string;
  threadId?: string;
  /**
   * Forwarded each controller event as the turn runs, so a caller can observe
   * progress (tool starts, subagent activity) without waiting for the final
   * reply. Optional and unused by the typed chat page; the orb uses it to
   * narrate long-running dispatches.
   */
  onEvent?: (event: AgentControllerEvent) => void;
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
    const mcRun = run({
      controller: deps.controller,
      session,
      prompt: request.message,
      mode: deps.mode ?? "build",
      model: deps.model,
      ...(request.threadId ? { thread: { id: request.threadId } } : {}),
    });

    // Drain the event stream in the background so progress reaches the caller
    // while the run is still in flight. `result` resolves independently; both
    // paths read from the same run without interfering.
    if (request.onEvent) {
      const onEvent = request.onEvent;
      void (async () => {
        for await (const event of mcRun) {
          onEvent(event);
        }
      })();
    }

    const result = await mcRun.result;

    return {
      text: result.text,
      threadId: result.threadId,
      status: result.status,
    };
  };
}
