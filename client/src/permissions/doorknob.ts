/**
 * The doorknob signal.
 *
 * When an agent hits APPLICATION_NOT_FOUND, the daemon disguises the real
 * reason: the app is not absent, it is unpermitted. That disguise is correct
 * for the agent — it must not learn the registry's contents — but the user
 * deserves the truth. So the hub, which can see both the agent's reply and the
 * registry, listens for an agent that could not find an application the user
 * has not yet permitted, and says so.
 *
 * "The user hasn't given that application permission yet" is the line the orb
 * speaks. It is user-facing only, never an agent probe: the hub appends it to
 * the reply after the turn completes, so the agent's own context never sees it.
 */

import type { AgentTurn, ChatReply } from "../chat.ts";
import type { DaemonRegistryClient } from "./daemon-client.ts";

export const DOORKNOB_PREFIX = "The user hasn't given permission for";
export const DOORKNOB_SUFFIX = "yet. Check the permissions page to allow it.";

/**
 * Wrap an agent turn so the reply carries the doorknob signal when the agent
 * references an application the user has not permitted.
 *
 * The scan is deliberately simple: after the turn, the hub fetches the list of
 * unpermitted applications from the registry and checks whether any of their
 * names appear in the reply text. This is a heuristic, not a parser — but it is
 * safe, because the worst case is a false positive that says "check the
 * permissions page" to a user who has nothing to check, not a false negative
 * that hides the reason.
 */
export function withDoorknobSignal(
  turn: AgentTurn,
  client: DaemonRegistryClient,
): AgentTurn {
  return async (request) => {
    const reply = await turn(request);
    try {
      const note = await doorknobForReply(reply, client);
      if (note) return { ...reply, text: `${reply.text}\n\n${note}` };
    } catch {
      // The daemon is unreachable — the agent's reply stands on its own.
    }
    return reply;
  };
}

async function doorknobForReply(
  reply: ChatReply,
  client: DaemonRegistryClient,
): Promise<string | undefined> {
  const { applications } = await client.getApplicationPermissions();
  const unpermitted = applications.filter((app) => !app.permitted);
  if (unpermitted.length === 0) return undefined;

  const text = reply.text.toLowerCase();
  for (const app of unpermitted) {
    if (text.includes(app.name.toLowerCase())) {
      return `${DOORKNOB_PREFIX} ${app.name} ${DOORKNOB_SUFFIX}`;
    }
  }
  return undefined;
}
