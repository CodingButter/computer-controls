import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mastra } from "@mastra/core/mastra";
import { afterAll, beforeAll, expect, test } from "vitest";

import { resolveClientConfig } from "./config.ts";
import { prepareHub } from "./hub.ts";
import { OBLIGATIONS_MARKER, STANDING_OBLIGATIONS_ID } from "./obligations.ts";

/**
 * The wiring, read off the agent this hub actually boots.
 *
 * A processor that is written and tested but never mounted is the same thing as
 * no processor, and nothing else in the suite would notice: every unit test
 * below ./obligations.test.ts would keep passing. So this one asks the running
 * controller for the agent behind the current mode and reads the processors it
 * was configured with.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "comcon-obligations-"));
const KICKOFF = "Do not open any channel other than #support.";

let processors: { id?: string; processLLMRequest?: (args: never) => unknown }[];

beforeAll(async () => {
  const config = resolveClientConfig({
    ...process.env,
    COMCON_CLIENT_ROOT: root,
    COMCON_STANDING_OBLIGATIONS: `${KICKOFF}\n\n   \n`,
  });
  const hub = await prepareHub(config);
  new Mastra(hub.mastraArgs);
  await hub.finalize();

  const session = await hub.getSession();
  const agent = hub.base.controller.getCurrentAgent(session as never);
  processors = (await agent.listConfiguredInputProcessors()) as typeof processors;
}, 120_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("the hub's own agent carries the standing-obligations processor", () => {
  expect(processors.map((processor) => processor.id)).toContain(STANDING_OBLIGATIONS_ID);
});

test("a duty handed down at kickoff reaches the prompt the mounted processor builds", () => {
  const mounted = processors.find((processor) => processor.id === STANDING_OBLIGATIONS_ID)!;
  const { prompt } = mounted.processLLMRequest!({
    prompt: [{ role: "user", content: "read the last message" }],
    model: {},
    stepNumber: 0,
    steps: [],
    state: {},
  } as never) as { prompt: { role: string; content: string }[] };

  const block = prompt.find((message) => message.content?.includes?.(OBLIGATIONS_MARKER))!;
  // The whole path in one assertion: an environment variable set before this
  // process started is a line the model reads on the last call of a long run.
  expect(block.content).toContain(KICKOFF);
  expect(block.content).toContain("a skill to amend, not a step to retry");
});
