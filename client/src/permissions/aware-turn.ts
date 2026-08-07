import type { AgentTurn } from "../chat.ts";
import { deriveRefusal, type PermissionRefusal } from "./refusal.ts";
import type { PermissionRegistry, PermissionRow, PermissionsView } from "./registry.ts";

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

/**
 * The refusal, handed to the agent as context.
 *
 * The sentence comes from the same builder a denied tool call uses, so the
 * agent hears the level and the remedy in the page's own words rather than a
 * bare "not permitted" it can only relay as a shrug. The registry is
 * user-owned and deny-by-default: the setting is the person's to change, and
 * an agent that offered to change it would be offering to widen its own
 * permissions.
 */
export function permissionContextPrefix(refusal: PermissionRefusal): string {
  return `[context for the assistant: ${refusal.sentence} Say so if the request concerns it, and point at the permissions page. Never offer to change the setting yourself.]`;
}

/**
 * The mention that fires the signal: the request text contains an unpermitted
 * application's name, casefolded. When several match, the one mentioned
 * earliest wins; at the same position the longer name wins, so "google chrome"
 * beats "chrome" instead of losing to its own substring.
 */
function firstMentioned(message: string, apps: PermissionRow[]): PermissionRow | undefined {
  const folded = message.toLowerCase();
  let best: { app: PermissionRow; index: number } | undefined;
  for (const app of apps) {
    const name = app.name.toLowerCase().trim();
    if (!name) continue;
    const index = folded.indexOf(name);
    if (index === -1) continue;
    if (
      !best ||
      index < best.index ||
      (index === best.index && app.name.length > best.app.name.length)
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
    let view: PermissionsView | undefined;
    try {
      view = await registry.view();
    } catch {
      // A malformed config or a hiccuping census must not take the chat lane
      // down with it; the turn proceeds unprefixed, which is the behaviour
      // this wrapper was added to.
      view = undefined;
    }
    if (!view) return await turn(request);

    const row = firstMentioned(
      request.message,
      view.applications.filter((candidate) => !candidate.permitted),
    );
    if (!row) return await turn(request);

    // A mention is the agent about to look, so `observe` is the class at
    // stake — and the narrowest remedy that would answer it.
    const refusal = deriveRefusal({
      application: row.name,
      demanded: "observe",
      access: row.access,
      ...(row.classes ? { classes: row.classes } : {}),
      ceiling: view.ceiling,
      listed: true,
    });
    if (!refusal) return await turn(request);

    return await turn({
      ...request,
      message: `${permissionContextPrefix(refusal)}\n\n${request.message}`,
    });
  };
}
