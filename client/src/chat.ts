import { runMC } from "@mastra/code-sdk";
import type { MastraCodeAgentController } from "@mastra/code-sdk";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";

import { HUB_TURNS, type TurnScope } from "./turn.ts";

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
   *
   * A function when the choice can move: a pack picked on the Models page has
   * to reach the next turn, and a string captured at construction would have
   * pinned this hub to whatever was chosen when the process started.
   */
  model: string | (() => string);
  /**
   * The headless runner. Injected so the wiring can be proved without a model:
   * everything from the HTTP body to the runner options and back to the reply
   * is this module's code, and only the model call belongs to the SDK.
   */
  run?: typeof runMC;
  /**
   * Told about every controller event of every turn, whether the caller asked
   * for progress or not.
   *
   * `onEvent` above belongs to whoever started the turn; this belongs to the
   * hub. What the agent is touching is a property of the hub rather than of the
   * request that happened to start it — a face watching the desktop has to see
   * the work whether it was typed into the chat page or spoken at the orb.
   */
  observe?: (event: AgentControllerEvent) => void;
  /**
   * Where turn identity is minted. The hub's own scope unless a test supplies
   * another; the settings gate reads the same one, and a gate reading a scope
   * this function does not write would let every confirmation through.
   */
  turns?: TurnScope;
};

/**
 * One call here is one turn, and this is the only place that is true — below it
 * a turn is a run, a stream of events and any number of tool calls, and above it
 * an HTTP request that may be a retry. So this is where the turn gets its
 * identity, wrapping everything the agent does about the message including the
 * tools it reaches through subagents. What that identity is for is in ./turn.ts.
 */
export function createAgentTurn(deps: AgentTurnDeps): AgentTurn {
  const run = deps.run ?? runMC;
  const turns = deps.turns ?? HUB_TURNS;
  return async (request) => turns.run(() => runOneTurn(deps, run, request));
}

async function runOneTurn(
  deps: AgentTurnDeps,
  run: typeof runMC,
  request: ChatRequest,
): Promise<ChatReply> {
  const session = await deps.getSession();
  const mcRun = run({
    controller: deps.controller,
    session,
    prompt: request.message,
    mode: deps.mode ?? "build",
    // Read per turn, so the pack a person picked answers the next thing they
    // say rather than the next time this process boots.
    model: typeof deps.model === "function" ? deps.model() : deps.model,
    ...(request.threadId ? { thread: { id: request.threadId } } : {}),
  });

  // Drain the event stream in the background so progress reaches the caller
  // while the run is still in flight. `result` resolves independently; both
  // paths read from the same run without interfering.
  //
  // One drain, however many readers: the run is an async iterable, and
  // iterating it twice would hand each event to whichever loop got there
  // first. The hub's observer and the caller's are fanned out from here.
  const onEvent = request.onEvent;
  const observe = deps.observe;
  if (onEvent || observe) {
    void (async () => {
      for await (const event of mcRun) {
        observe?.(event);
        onEvent?.(event);
      }
    })();
  }

  const result = await mcRun.result;

  return {
    text: result.text,
    threadId: result.threadId,
    status: result.status,
  };
}
