import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mastra } from "@mastra/core/mastra";
import { afterAll, beforeAll, expect, test } from "vitest";

import { buildApp } from "./app.ts";
import { resolveClientConfig } from "./config.ts";
import { prepareHub } from "./hub.ts";

/**
 * The half of a chat turn a portable lane cannot run: the model call.
 *
 * Excluded from the default suite the same way the plugin's gate tests are,
 * because it spends a real credential against a real provider. Run it with
 * `pnpm test:gate` on a machine that has signed in through the TUI, and read
 * the answer it prints — a turn that returns empty text is a failure even when
 * the status says completed.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "comcon-chat-gate-"));

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  // The SDK swaps in a fake credential whenever it sees a test environment,
  // which is the right guard for every lane except this one: the entire job
  // of this test is to spend a real credential on purpose. Under vitest the
  // VITEST flag is always set, so without this the lane can never pass on
  // any machine, signed in or not.
  delete process.env.VITEST;
  process.env.NODE_ENV = "production";
  const config = resolveClientConfig({ ...process.env, COMCON_CLIENT_ROOT: root });
  const hub = await prepareHub(config);
  new Mastra(hub.mastraArgs);
  await hub.finalize();
  app = buildApp({ chat: hub.chat, uiRoot: config.uiRoot, status: hub.status });
}, 120_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("a chat turn reaches a real model and returns an answer", async () => {
  const response = await app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Reply with the single word: ready." }),
  });

  expect(response.status).toBe(200);
  const reply = (await response.json()) as { text: string; threadId?: string; status: string };
  console.log("[gate] model answered:", JSON.stringify(reply));
  expect(reply.status).toBe("completed");
  expect(reply.text.trim()).not.toBe("");
  expect(reply.threadId).toBeTruthy();
}, 180_000);
