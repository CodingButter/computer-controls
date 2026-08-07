/**
 * The gate this whole feature rests on, run against the real runtime.
 *
 * The claim: a `processLLMRequest` processor can put text in front of the model
 * on every single call, and that text never lands in the conversation. If the
 * first half is wrong the obligations are decorative. If the second half is
 * wrong they are worse than decorative — every call would append another copy
 * of the same duties to the history, and a twenty-turn run would spend its
 * context re-reading forty stale restatements of "verify against the tree".
 *
 * Proven with a model that records the prompt it was handed and answers with a
 * fixed word. The first run makes the model call a tool, so the loop runs two
 * model calls over one growing message list: if injection persisted, the second
 * prompt would carry the block twice. It carries it once.
 *
 * This is a gate rather than a portable test because what it proves is a
 * property of @mastra/core, not of this repository. Run it after any bump of
 * the runtime: if it fails, the design under it is wrong and the fallback — a
 * tagged system message that accepts persistence — is a different plan, not a
 * patch.
 */
import { Agent } from "@mastra/core/agent";
import { expect, it } from "vitest";
import { z } from "zod";

import { OBLIGATIONS_MARKER, standingObligations } from "./obligations.ts";

type Recorded = { role: string; content: unknown }[];

/**
 * A model that says what it was asked and nothing else.
 *
 * `toolCall` makes the first call ask for a tool, which is what gets the loop
 * to make a second model call inside one run — the shape that would expose a
 * leak into the message list.
 */
function recordingModel(recorded: Recorded[], script: ("toolCall" | "text")[]) {
  let call = 0;
  return {
    specificationVersion: "v2" as const,
    provider: "gate",
    modelId: "records-its-prompt",
    supportedUrls: {},
    doGenerate: async ({ prompt }: { prompt: Recorded }) => {
      recorded.push(structuredClone(prompt));
      const step = script[call++] ?? "text";
      return {
        content:
          step === "toolCall"
            ? [
                {
                  type: "tool-call" as const,
                  toolCallId: `call-${call}`,
                  toolName: "note",
                  input: JSON.stringify({ what: "looking" }),
                },
              ]
            : [{ type: "text" as const, text: "done" }],
        finishReason: step === "toolCall" ? ("tool-calls" as const) : ("stop" as const),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("this gate drives the loop through doGenerate");
    },
  };
}

function gateAgent(recorded: Recorded[], script: ("toolCall" | "text")[]) {
  return new Agent({
    id: "obligations-gate",
    name: "obligations-gate",
    instructions: "You drive a desktop.",
    model: recordingModel(recorded, script) as never,
    tools: {
      note: {
        id: "note",
        description: "Write down what you are looking at.",
        inputSchema: z.object({ what: z.string() }),
        execute: async () => ({ noted: true }),
      },
    },
    inputProcessors: [standingObligations()],
  });
}

function systemTexts(prompt: Recorded): string[] {
  return prompt
    .filter((message) => message.role === "system" && typeof message.content === "string")
    .map((message) => message.content as string);
}

it("puts the standing obligations in front of the model on every call", async () => {
  const recorded: Recorded[] = [];
  const result = await gateAgent(recorded, ["toolCall", "text"]).generate("read the last message");

  expect(result.text).toBe("done");
  // Two model calls in one run: the tool call, then the answer after it.
  expect(recorded).toHaveLength(2);

  for (const prompt of recorded) {
    const blocks = systemTexts(prompt).filter((text) => text.includes(OBLIGATIONS_MARKER));
    // Once per call — not zero, which would mean the seam does not reach the
    // provider, and not twice, which would mean the first call's injection was
    // written into the message list the second call was built from.
    expect(blocks).toHaveLength(1);
    // Verbatim, because a duty paraphrased by the machinery carrying it is a
    // duty nobody agreed to.
    expect(blocks[0]).toContain("a skill to amend, not a step to retry");
    // And ahead of the conversation: the leading system block is the only
    // place Anthropic-family providers accept a system message at all.
    expect(prompt.findIndex((message) => message.role !== "system")).toBeGreaterThan(
      prompt.findIndex((message) => systemTexts([message]).some((t) => t.includes(OBLIGATIONS_MARKER))),
    );
  }

  // Nothing the model was shown reaches what the run says it said. This is the
  // half that makes re-injection affordable: the transcript stays the
  // conversation, and the obligations stay a property of the call.
  expect(JSON.stringify(result.response.messages)).not.toContain(OBLIGATIONS_MARKER);
});

it("still injects once when a run is long enough to have buried its kickoff", async () => {
  const recorded: Recorded[] = [];
  const agent = gateAgent(recorded, ["text"]);

  // The burial shape from the issue: the duty was stated at message zero and
  // the model is now forty messages downstream of it.
  const history = Array.from({ length: 40 }, (_, index) =>
    index % 2 === 0
      ? { role: "user" as const, content: `turn ${index}` }
      : { role: "assistant" as const, content: `turn ${index}` },
  );

  await agent.generate([...history, { role: "user" as const, content: "why did that fail?" }]);

  const blocks = systemTexts(recorded[0]!).filter((text) => text.includes(OBLIGATIONS_MARKER));
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toContain("name a check you ran and what it returned");
});
