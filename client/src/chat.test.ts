import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mastra } from "@mastra/core/mastra";
import { afterAll, beforeAll, expect, test } from "vitest";

import { buildApp } from "./app.ts";
import { createAgentTurn } from "./chat.ts";
import type { HubController, HubSession } from "./chat.ts";
import { resolveClientConfig } from "./config.ts";
import { prepareHub } from "./hub.ts";

/**
 * A chat turn, end to end, minus the model.
 *
 * The controller and the session here are the real ones this hub boots; only
 * the runner is replaced, and it records exactly what the route handed it. That
 * is the honest portable half: whether a model answers depends on credentials
 * this lane does not have, but whether the browser's message reaches the agent
 * with the right session and comes back as a reply is decided by code in this
 * repository, and this test decides it.
 *
 * The half that needs a model lives in chat-model.gate.test.ts.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "comcon-chat-"));

let app: ReturnType<typeof buildApp>;
let hubController: HubController;
let received: { controller: HubController; session: HubSession; prompt?: string; thread?: unknown }[];

beforeAll(async () => {
  const config = resolveClientConfig({ ...process.env, COMCON_CLIENT_ROOT: root });
  const hub = await prepareHub(config);
  hubController = hub.base.controller;
  new Mastra(hub.mastraArgs);
  await hub.finalize();

  received = [];
  const chat = createAgentTurn({
    controller: hub.base.controller,
    getSession: hub.getSession,
    model: hub.modelPack.models.standard,
    run: ((options: Record<string, unknown>) => {
      received.push(options as never);
      return {
        result: Promise.resolve({
          status: "completed",
          text: `heard: ${options.prompt as string}`,
          threadId: "thread-1",
          toolCalls: [],
          toolResults: [],
          exitCode: 0,
        }),
      };
    }) as never,
  });

  app = buildApp({ chat, uiRoot: config.uiRoot, status: hub.status });
}, 120_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("test_a_chat_turn_reaches_the_agent_and_returns", async () => {
  const response = await app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "what windows are open?" }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    text: "heard: what windows are open?",
    threadId: "thread-1",
    status: "completed",
  });

  expect(received).toHaveLength(1);
  const turn = received[0]!;
  expect(turn.prompt).toBe("what windows are open?");
  // The agent the turn reached is the hub's own controller and the hub's own
  // session — not a pair the test built to keep itself company.
  expect(turn.controller).toBe(hubController);
  expect(turn.session.identity.getResourceId()).toBe("local-browser");
  expect(turn.session).toBe(await hubController.getSessionByResource("local-browser"));
});

test("a second turn continues the thread the first one opened", async () => {
  await app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "and the first one?", threadId: "thread-1" }),
  });

  expect(received.at(-1)!.thread).toEqual({ id: "thread-1" });
  // Same session across turns: the browser is one caller with one history.
  expect(received.at(-1)!.session).toBe(received[0]!.session);
});

test("an empty message is refused before it reaches the agent", async () => {
  const before = received.length;
  const response = await app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "   " }),
  });

  expect(response.status).toBe(400);
  expect(received).toHaveLength(before);
});
