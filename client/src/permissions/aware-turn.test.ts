import path from "node:path";
import { expect, test } from "vitest";

import { buildApp, type ClientStatus } from "../app.ts";
import type { AgentTurn, ChatRequest } from "../chat.ts";
import { createHubBrain } from "../orb/brain.ts";
import { permissionContextPrefix, wrapTurnWithPermissionAwareness } from "./aware-turn.ts";
import { deriveRefusal } from "./refusal.ts";
import type { PermissionRegistry, PermissionsView } from "./registry.ts";

function registryWith(unpermitted: string[]): PermissionRegistry {
  return {
    view: async (): Promise<PermissionsView> => ({
      mode: "per-application",
      daemon: { reachable: true },
      ceiling: ["observe", "edit", "activate"],
      applications: unpermitted.map((name) => ({
        name,
        permitted: false,
        access: "off",
        running: true,
        readable: true,
      })),
    }),
    setAccess: async () => {
      throw new Error("not under test");
    },
    refusalFor: async () => {
      throw new Error("not under test");
    },
  };
}

/** The prefix this wrapper should build for an application at `off`. */
function expectedPrefix(app: string): string {
  return `[context for the assistant: "${app}" is set to "off" on the permissions page, which does not permit observe-class actions. Open the permissions page and switch "${app}" from "off" to "view". Say so if the request concerns it, and point at the permissions page. Never offer to change the setting yourself.]`;
}

function recordingTurn(): { turn: AgentTurn; seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  return {
    seen,
    turn: async (request) => {
      seen.push(request);
      return { text: "ok", status: "ok", ...(request.threadId ? { threadId: request.threadId } : {}) };
    },
  };
}

test("a request naming an unpermitted application gets the exact prefix", async () => {
  const { turn, seen } = recordingTurn();
  const wrapped = wrapTurnWithPermissionAwareness(turn, registryWith(["Discord"]));

  await wrapped({ message: "What did Cookie say on Discord?" });

  // The whole point of #184: the context names the application, the level it
  // is at, and the switch that would change it — not merely "not permitted".
  expect(seen[0]!.message).toBe(`${expectedPrefix("Discord")}\n\nWhat did Cookie say on Discord?`);
  expect(seen[0]!.message).toContain("Discord");
  expect(seen[0]!.message).toContain("permissions page");
  expect(seen[0]!.message).toContain('to "view"');
});

test("permitted and unknown applications get no prefix", async () => {
  const { turn, seen } = recordingTurn();
  const wrapped = wrapTurnWithPermissionAwareness(turn, registryWith(["Discord"]));

  await wrapped({ message: "Open the file manager for me" });
  expect(seen[0]!.message).toBe("Open the file manager for me");

  // Nothing unpermitted at all: every request rides through untouched.
  const clean = recordingTurn();
  const openWrapped = wrapTurnWithPermissionAwareness(clean.turn, registryWith([]));
  await openWrapped({ message: "check Discord for me" });
  expect(clean.seen[0]!.message).toBe("check Discord for me");
});

test("the prefix survives threadId passthrough", async () => {
  const { turn, seen } = recordingTurn();
  const wrapped = wrapTurnWithPermissionAwareness(turn, registryWith(["Discord"]));

  const reply = await wrapped({ message: "discord please", threadId: "thread-7" });

  expect(seen[0]!.threadId).toBe("thread-7");
  expect(seen[0]!.message.startsWith("[context for the assistant:")).toBe(true);
  expect(reply.threadId).toBe("thread-7");
});

test("the earliest mention wins, and at a tie the longer name beats its own substring", async () => {
  const { turn, seen } = recordingTurn();
  const wrapped = wrapTurnWithPermissionAwareness(
    turn,
    registryWith(["Google Chrome", "Chrome", "Discord"]),
  );

  await wrapped({ message: "use google chrome, not discord" });
  expect(seen[0]!.message.startsWith(expectedPrefix("Google Chrome"))).toBe(true);
});

test("a registry that cannot answer never takes the chat lane down", async () => {
  const { turn, seen } = recordingTurn();
  const broken: PermissionRegistry = {
    ...registryWith([]),
    view: async () => {
      throw new Error("malformed config");
    },
  };
  const wrapped = wrapTurnWithPermissionAwareness(turn, broken);

  const reply = await wrapped({ message: "check discord" });
  expect(reply.status).toBe("ok");
  expect(seen[0]!.message).toBe("check discord");
});

test("both transports ride the same wrapped turn: the orb's brain and the typed route", async () => {
  // Exactly the entry module's shape: wrap once, hand the same function to
  // the orb mount and to the app. If the wrap ever moves to only one of the
  // two call sites, one of these assertions goes red.
  const { turn, seen } = recordingTurn();
  const wrapped = wrapTurnWithPermissionAwareness(turn, registryWith(["Discord"]));

  // Voice: the brain invokes the turn the way mountOrb's ask_the_hub does.
  const brain = createHubBrain({ turn: wrapped });
  await brain.ask("what did cookie send me on discord");

  // Typing: the same wrapped function behind POST /api/chat.
  const status = async (): Promise<ClientStatus> => ({
    tools: [],
    desktopScope: "observe",
    plugins: { admitted: [], refused: [] },
    model: { pack: "test", thinking: "test", tiers: {} },
    platform: { id: "freedesktop", supports: { installedScan: true, icons: true, shortcutCuring: true, autostart: true } },
  });
  const app = buildApp({
    chat: wrapped,
    uiRoot: path.resolve(import.meta.dirname, "..", "..", "public"),
    status,
  });
  const response = await app.request("/api/chat", {
    method: "POST",
    body: JSON.stringify({ message: "open discord and read my messages" }),
    headers: { "content-type": "application/json" },
  });
  expect(response.status).toBe(200);

  expect(seen).toHaveLength(2);
  for (const request of seen) {
    expect(request.message.startsWith(expectedPrefix("Discord"))).toBe(true);
  }
});

test("the prefix is the refusal builder's own sentence, not a second phrasing of it", async () => {
  // One author for the page's vocabulary: if the builder's sentence changes,
  // the chat lane changes with it rather than drifting into a stale wording.
  const refusal = deriveRefusal({
    application: "Discord",
    demanded: "observe",
    access: "off",
    ceiling: ["observe", "edit", "activate"],
    listed: true,
  });

  expect(permissionContextPrefix(refusal!)).toBe(expectedPrefix("Discord"));
});
