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

import type { AgentTurn } from "../chat.ts";
import type { HubBrain } from "./orb.ts";

export function createHubBrain(deps: {
  turn: AgentTurn;
  /** Resolved per call so the orb rides the same thread the chat page is on. */
  threadId?: () => string | undefined;
}): HubBrain {
  return {
    async ask(request: string): Promise<string> {
      const threadId = deps.threadId?.();
      const reply = await deps.turn({
        message: request,
        ...(threadId ? { threadId } : {}),
      });
      // The provider speaks this, so an empty answer would be silence in the
      // middle of a conversation. Saying that nothing came back is worse to
      // read and better to hear than nothing at all.
      return reply.text.trim() || "I did that, but there was nothing to report back.";
    },
  };
}
