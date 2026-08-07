import { expect, test } from "vitest";

import {
  buildObligationsBlock,
  MAX_BLOCK_CHARS,
  OBLIGATIONS_MARKER,
  standingObligations,
  STANDING_OBLIGATIONS_ID,
} from "./obligations.ts";

type Prompt = { role: string; content: unknown }[];

function inject(prompt: Prompt, extra: string[] = []): Prompt {
  const processor = standingObligations({ extra });
  const result = processor.processLLMRequest!({
    prompt: prompt as never,
    model: {} as never,
    stepNumber: 0,
    steps: [],
    state: {},
    retryCount: 0,
    abort: (() => {
      throw new Error("this processor has no reason to abort a request");
    }) as never,
  }) as { prompt: Prompt };
  return result.prompt;
}

function blocks(prompt: Prompt): string[] {
  return prompt
    .filter(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes(OBLIGATIONS_MARKER),
    )
    .map((message) => message.content as string);
}

test("the standing duties are stated verbatim, whatever else is asked for", () => {
  const block = buildObligationsBlock();

  expect(block).toContain(OBLIGATIONS_MARKER);
  expect(block).toContain("a skill to amend, not a step to retry");
  expect(block).toContain("name a check you ran and what it returned, never doctrine");
  expect(block).toContain("The tree in front of you outranks the skill's route");
  // The same inputs make the same block: a prompt that differs between two
  // calls has to mean something changed, not that a clock moved.
  expect(buildObligationsBlock()).toBe(block);
});

test("a task's own do-nots ride along with the standing ones", () => {
  const block = buildObligationsBlock(["Do not open a channel other than #support.", "  ", ""]);

  expect(block).toContain("Do not open a channel other than #support.");
  // Blank lines are not obligations, and an empty bullet teaches an agent that
  // this block contains noise worth skimming past.
  expect(block).not.toMatch(/- +\n/);
});

test("what does not fit is announced, because a silently dropped duty is the bug itself", () => {
  const many = Array.from({ length: 20 }, (_, index) => `Extra obligation number ${index} `.repeat(2));
  const block = buildObligationsBlock(many);

  expect(block.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
  // The constant duties are never the ones sacrificed to the budget.
  expect(block).toContain("a skill to amend, not a step to retry");
  expect(block).toMatch(/\d+ further standing obligations did not fit here\./);
});

test("the block sits at the end of the leading system messages", () => {
  const prompt = inject([
    { role: "system", content: "You drive a desktop." },
    { role: "user", content: "read the last message" },
    { role: "assistant", content: "looking" },
  ]);

  expect(prompt.map((message) => message.role)).toEqual(["system", "system", "user", "assistant"]);
  // Second, not first: the agent's own instructions stay the opening frame, and
  // a system message after a user message is what Anthropic-family providers
  // reject outright.
  expect(prompt[1]!.content).toContain(OBLIGATIONS_MARKER);
});

test("a prompt with no system messages at all still gets the block first", () => {
  const prompt = inject([{ role: "user", content: "why did that fail?" }]);

  expect(prompt).toHaveLength(2);
  expect(prompt[0]!.role).toBe("system");
});

test("running twice over one prompt leaves one block, not two", () => {
  const once = inject([
    { role: "system", content: "You drive a desktop." },
    { role: "user", content: "again" },
  ]);
  const twice = inject(once);

  expect(blocks(twice)).toHaveLength(1);
  // Including the case the loop actually produces: a stale block carried in
  // from a previous call is replaced, so the duties in front of the model are
  // this call's, never a copy of an older run's.
  expect(twice).toEqual(once);
});

test("the duty survives a history long enough to have buried the message that stated it", () => {
  const history: Prompt = [
    { role: "system", content: "You drive a desktop." },
    { role: "user", content: "If you cannot find it by the route, amend the skill." },
    ...Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? "assistant" : "user",
      content: `turn ${index}`,
    })),
  ];

  const prompt = inject(history);

  expect(blocks(prompt)).toHaveLength(1);
  // The conversation is untouched — the duty is not smuggled in as a turn — and
  // the block is there on this call regardless of how far back the message
  // stating it fell. Depth is what it stops mattering.
  expect(prompt.slice(-1)[0]!.content).toBe("turn 59");
  expect(prompt[1]!.content).toContain(OBLIGATIONS_MARKER);
});

test("a prompt whose content is not a string is left alone rather than crashed on", () => {
  // Every multimodal and tool-result message in a real run looks like this.
  const prompt = inject([
    { role: "user", content: [{ type: "text", text: "look" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", result: {} }] },
  ]);

  expect(blocks(prompt)).toHaveLength(1);
  expect(prompt).toHaveLength(3);
});

test("the processor is addressable by name, which is how the hub proves it mounted", () => {
  expect(standingObligations().id).toBe(STANDING_OBLIGATIONS_ID);
});
