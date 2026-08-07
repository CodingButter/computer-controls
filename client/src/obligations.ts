import type { InputProcessor } from "@mastra/core/processors";

/**
 * The duties a run is held to, put back in front of the model every call.
 *
 * A worker's standing obligations are the contract of the job: amend a skill
 * whose landmark is gone, explain a refusal from a check rather than from
 * doctrine, trust the tree over the route. Every one of them was already
 * written down somewhere the agent had read — in the skill's own header, in the
 * kickoff message — and every one of them lost an argument to depth. A duty
 * stated at turn one is a fossil by turn forty: it is still in the transcript,
 * and it is no longer in the model's attention.
 *
 * So this is not memory and not a message. The block is rebuilt from its inputs
 * and inserted into the prompt on every single model call, and it is never
 * written back into the conversation. Nothing here can be summarised away,
 * compacted out, or argued with by an earlier turn, because there is no earlier
 * copy of it to find — see `standingObligations` below, and the proof that the
 * runtime really behaves this way in ./obligations.gate.test.ts.
 */
export const OBLIGATIONS_MARKER = "Standing obligations for this run";

/**
 * The ceiling the block is written to fit under, in characters.
 *
 * Roughly two hundred tokens at four characters each. A cap measured in
 * characters is deterministic where a tokenizer call would not be, and this
 * text is paid for on every call of every turn — an obligations block that
 * grew without a ceiling would buy back its own burial by crowding out the work
 * it is supposed to govern.
 */
export const MAX_BLOCK_CHARS = 800;

export const STANDING_OBLIGATIONS_ID = "standing-obligations";

const HEADER = `${OBLIGATIONS_MARKER} — restated every turn, because a duty stated once is a fossil by turn forty:`;

/**
 * The duties that hold for every run, whatever the task is.
 *
 * The first says "propose" rather than "amend" on purpose: the commons is
 * mounted read-only and this session holds no file-writing tools, so the way a
 * skill changes here is a proposal somebody merges. Telling an agent to do
 * something its toolbox cannot do teaches it that these lines are decoration.
 */
const DUTIES = [
  "A landmark the skill names but the tree does not have is a skill to amend, not a step to retry — say so, and propose the amendment, before you finish.",
  "A refusal or a failure explanation must name a check you ran and what it returned, never doctrine.",
  "The tree in front of you outranks the skill's route: verify each step against what the desktop reports now.",
] as const;

function render(lines: readonly string[], dropped: number): string {
  const body = [HEADER, ...lines.map((line) => `- ${line}`)];
  if (dropped > 0) {
    const plural = dropped === 1 ? "obligation" : "obligations";
    body.push(`- ${dropped} further standing ${plural} did not fit here.`);
  }
  return body.join("\n");
}

/**
 * The block as it goes to the model, standing duties first.
 *
 * The constant duties always survive: they are the reason this exists, and a
 * budget that could drop them would make the whole mechanism conditional on how
 * chatty a kickoff was. Task-specific lines fill what is left of the cap in the
 * order they were handed down, and what does not fit is *announced* rather than
 * dropped in silence — an agent that is told three duties when four were set
 * cannot know it is missing one, which is the same failure this file exists to
 * end.
 *
 * Deterministic by construction: same inputs, same block, no clock and no
 * randomness, so a prompt diff between two calls means something changed.
 */
export function buildObligationsBlock(extra: readonly string[] = []): string {
  const kept: string[] = [...DUTIES];
  const pending = extra.map((line) => line.trim()).filter((line) => line.length > 0);

  for (let index = 0; index < pending.length; index++) {
    const line = pending[index]!;
    const remaining = pending.length - index - 1;
    if (render([...kept, line], remaining).length > MAX_BLOCK_CHARS) {
      return render(kept, pending.length - index);
    }
    kept.push(line);
  }

  return render(kept, 0);
}

function carriesObligations(message: { role: string; content: unknown }): boolean {
  return (
    message.role === "system" &&
    typeof message.content === "string" &&
    message.content.includes(OBLIGATIONS_MARKER)
  );
}

/**
 * Where the block is put, which is the whole reason this is a processor.
 *
 * `processLLMRequest` runs after the message list has been converted to the
 * provider-shaped prompt and immediately before that prompt is sent, and the
 * runtime documents its mutations as scoped to the single call: they do not
 * reach the persisted message list, memory, or the UI. That is exactly the
 * property this needs, and it is enforced by the framework rather than by our
 * good intentions — proven in ./obligations.gate.test.ts, which is the test to
 * run first after any runtime upgrade.
 *
 * The alternatives were all worse in the same direction. Plugin `instructions`
 * resolve once at load, which is burial by definition. A tagged system message
 * from `processInput` persists, so turn forty would carry forty copies of a
 * duty and the model would still be reading the oldest one. Appending at the
 * end of the prompt breaks Anthropic-family validation, which rejects a system
 * message that follows a non-system one — hence the insert at the end of the
 * leading system block.
 */
export function standingObligations(options: { extra?: readonly string[] } = {}): InputProcessor {
  return {
    id: STANDING_OBLIGATIONS_ID,
    processLLMRequest: ({ prompt }) => {
      // Rebuilt per call rather than closed over: a cached obligation is a
      // frozen census in a different costume, and the cost of rebuilding a
      // few hundred characters is nothing next to being wrong about the job.
      const block = buildObligationsBlock(options.extra ?? []);

      // Any earlier copy goes first, so running twice over one prompt leaves
      // one block. Idempotence by construction beats idempotence by luck.
      const carried = prompt.filter((message) => !carriesObligations(message));
      let insertAt = 0;
      while (insertAt < carried.length && carried[insertAt]!.role === "system") insertAt++;

      return {
        prompt: [
          ...carried.slice(0, insertAt),
          { role: "system", content: block },
          ...carried.slice(insertAt),
        ],
      };
    },
  };
}
