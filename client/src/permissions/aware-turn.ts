import type { AgentTurn } from "../chat.ts";
import type { PermissionRegistry } from "./registry.ts";

/**
 * The "no permission yet" signal, installed at the one place both transports
 * pass through.
 *
 * The daemon makes an unpermitted application ABSENT from every listing, so
 * without this the agent would honestly report that Discord does not seem to
 * be running — true from where it stands, useless to the person who installed
 * Discord an hour ago. The registry knows the difference, and this wrapper
 * hands that knowledge to the agent as context in the request itself, because
 * `ChatRequest` is a message and a thread id and nothing else: there is no
 * system channel, so the prefix IS the mechanism.
 *
 * Wrapped once, at the definition site's return — a request that arrived by
 * voice is indistinguishable downstream from one that arrived by typing, and
 * this keeps it that way: the orb's turn and the typed route's chat are the
 * same wrapped function.
 */

export function permissionContextPrefix(app: string): string {
  return `[context for the assistant: "${app}" is installed but the user has not granted it permission on the Permissions page. If the request concerns it, say so and point there.]`;
}

/**
 * The mention that fires the signal: the request text contains an unpermitted
 * application's name, casefolded. When several match, the one mentioned
 * earliest wins; at the same position the longer name wins, so "google chrome"
 * beats "chrome" instead of losing to its own substring.
 */
function firstMentioned(message: string, apps: string[]): string | undefined {
  const folded = message.toLowerCase();
  let best: { app: string; index: number } | undefined;
  for (const app of apps) {
    const name = app.toLowerCase().trim();
    if (!name) continue;
    const index = folded.indexOf(name);
    if (index === -1) continue;
    if (
      !best ||
      index < best.index ||
      (index === best.index && app.length > best.app.length)
    ) {
      best = { app, index };
    }
  }
  return best?.app;
}

export function wrapTurnWithPermissionAwareness(
  turn: AgentTurn,
  registry: PermissionRegistry,
): AgentTurn {
  return async (request) => {
    let unpermitted: string[];
    try {
      unpermitted = await registry.unpermittedApps();
    } catch {
      // A malformed config or a hiccuping census must not take the chat lane
      // down with it; the turn proceeds unprefixed, which is the behaviour
      // this wrapper was added to.
      unpermitted = [];
    }

    const mentioned = firstMentioned(request.message, unpermitted);
    if (!mentioned) return await turn(request);

    return await turn({
      ...request,
      message: `${permissionContextPrefix(mentioned)}\n\n${request.message}`,
    });
  };
}
