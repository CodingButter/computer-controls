/**
 * The one function call, landing on the agent the chat page already talks to.
 *
 * There is no second brain and no orb-specific agent. `AgentTurn` is the same
 * turn the typed lane runs — same session, same thread, same model pack, same
 * consent ceiling — so a request that arrived by voice is indistinguishable
 * downstream from one that was typed, and the orb inherits every guarantee the
 * chat page already has instead of restating them.
 *
 * Sharing the thread is deliberate. Asking the orb to "do that again" after
 * typing something is a reasonable thing for a person to expect, and it only
 * works if both faces write into one history.
 */

import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import type { AgentTurn } from "../chat.ts";

/**
 * The whole dispatch seam: one method, callable with nothing but a request.
 * It lived on the hub-side orb before the retirement; the lane's `LaneBrain`
 * is structurally identical on purpose, and deliberately not imported —
 * see events/socket.ts for why the lane refuses to depend on this module.
 */
export type HubBrain = {
  ask(request: string, onProgress?: (signal: string) => void): Promise<string>;
};

/**
 * Map a controller event to an outcome-shaped progress fact — what surface is
 * being touched, not what was found there. Content never appears in a progress
 * signal; it appears only in the final spoken answer.
 */
function progressFromEvent(event: AgentControllerEvent): string | undefined {
  switch (event.type) {
    case "tool_start": {
      const name = event.toolName.replace(/[_-]/g, " ").trim();
      return name ? `You are now working on: ${name}.` : undefined;
    }
    case "subagent_start": {
      const task = event.task?.trim();
      return task ? `You are now: ${task}.` : undefined;
    }
    default:
      return undefined;
  }
}

export function createHubBrain(deps: {
  turn: AgentTurn;
  /** Resolved per call so the orb rides the same thread the chat page is on. */
  threadId?: () => string | undefined;
}): HubBrain {
  return {
    async ask(request: string, onProgress?: (signal: string) => void): Promise<string> {
      const threadId = deps.threadId?.();
      const reply = await deps.turn({
        message: request,
        ...(threadId ? { threadId } : {}),
        ...(onProgress
          ? {
              onEvent: (event: AgentControllerEvent) => {
                const signal = progressFromEvent(event);
                if (signal) onProgress(signal);
              },
            }
          : {}),
      });
      // The provider speaks this, so an empty answer would be silence in the
      // middle of a conversation. Saying that nothing came back is worse to
      // read and better to hear than nothing at all.
      return reply.text.trim() || "I did that, but there was nothing to report back.";
    },
  };
}
