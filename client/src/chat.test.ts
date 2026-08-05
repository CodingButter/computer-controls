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
let hubSession: () => Promise<HubSession>;
let received: { controller: HubController; session: HubSession; prompt?: string; thread?: unknown }[];

beforeAll(async () => {
  const config = resolveClientConfig({ ...process.env, COMCON_CLIENT_ROOT: root });
  const hub = await prepareHub(config);
  hubController = hub.base.controller;
  hubSession = hub.getSession;
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

test("test_the_hub_sees_the_agent_work_on_a_turn_that_asked_for_nothing", async () => {
  const events = [
    { type: "tool_start", toolCallId: "call-1", toolName: "desktop_invoke_element", args: {} },
    { type: "tool_end", toolCallId: "call-1", result: {}, isError: false },
  ];

  const observed: unknown[] = [];
  const asked: unknown[] = [];
  const turn = createAgentTurn({
    controller: hubController,
    getSession: hubSession,
    model: "whichever",
    observe: (event) => observed.push(event),
    run: (() => {
      const run = {
        result: Promise.resolve({ status: "completed", text: "done", threadId: "t" }),
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
      };
      return run;
    }) as never,
  });

  // No `onEvent`: this is the typed chat page, which never asks for progress.
  // The hub is told anyway, because where the agent's hands are is the hub's
  // fact and not the caller's.
  await turn({ message: "click it" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed).toEqual(events);

  // And when a caller does ask, the stream is drained once and fanned out —
  // two loops over one async iterable would race for each event and each side
  // would see half a turn.
  observed.length = 0;
  await turn({ message: "click it again", onEvent: (event) => asked.push(event) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed).toEqual(events);
  expect(asked).toEqual(events);
});

test("the model is read per turn, so a pack chosen after boot answers the next thing said", async () => {
  const asked: string[] = [];
  let pack = "anthropic/claude-sonnet-4-6";
  const turn = createAgentTurn({
    controller: hubController,
    getSession: hubSession,
    // A function rather than a string: this is the seam the Models page moves.
    model: () => pack,
    run: ((options: Record<string, unknown>) => {
      asked.push(options.model as string);
      return {
        result: Promise.resolve({ status: "completed", text: "ok", threadId: "t" }),
      };
    }) as never,
  });

  await turn({ message: "before" });
  pack = "anthropic/claude-opus-4-6";
  await turn({ message: "after" });

  // No restart between them: the second turn thinks with the pack that was
  // picked while the first one was still the answer.
  expect(asked).toEqual(["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"]);
});

test("the hub thinks with the pack it is handed, and health says which one", async () => {
  const config = resolveClientConfig({ ...process.env, COMCON_CLIENT_ROOT: root });
  let chosen = {
    id: "picked-on-the-page",
    models: {
      minimal: "anthropic/claude-haiku-4-5",
      standard: "anthropic/claude-opus-4-6",
      heavy: "anthropic/claude-opus-4-6",
    },
  };
  const hub = await prepareHub(config, { activePack: () => chosen });

  const first = await hub.status();
  expect(first.model).toEqual({
    pack: "picked-on-the-page",
    thinking: "anthropic/claude-opus-4-6",
    tiers: chosen.models,
  });

  chosen = { ...chosen, id: "picked-again", models: { ...chosen.models, standard: "anthropic/claude-haiku-4-5" } };
  const second = await hub.status();
  // Health reports the pack answering now rather than the one this process
  // booted with, which is what makes a switch checkable rather than claimed.
  expect(second.model.pack).toBe("picked-again");
  expect(second.model.thinking).toBe("anthropic/claude-haiku-4-5");
}, 120_000);

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
