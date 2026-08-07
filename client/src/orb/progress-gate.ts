/**
 * The gate between "the agent did something" and "the orb says something".
 *
 * Every tool call is an event, but almost none of them are news. Reading a file
 * is not worth interrupting a person for, and a dozen of them in a row is a
 * monologue nobody asked for. This decides which events earn a sentence.
 *
 * Signals are dropped, never deferred. A held signal would arrive after the
 * step it describes is finished — the orb narrating backwards — and the mouth
 * already purges queued progress when an answer lands for exactly that reason.
 * Late narration is worse than none.
 */

import type { AgentControllerEvent } from "@mastra/core/agent-controller";

/**
 * How much a signal is worth saying out loud. Rank buys a shorter quiet
 * window, not a bypass: starting a subagent is more interesting than opening a
 * file, but ten subagents in parallel is still a firehose.
 */
export type Significance = "routine" | "notable";

/**
 * How long the orb stays quiet after speaking, per rank. Starting values, not
 * a contract — retuning the orb's talkativeness should mean editing this table
 * and nothing else.
 */
export const QUIET_MS: Record<Significance, number> = {
  routine: 20_000,
  notable: 5_000,
};

export type ProgressGate = {
  /** The sentence to speak, or nothing if this event doesn't earn one. */
  admit(event: AgentControllerEvent): string | undefined;
};

type Candidate = { text: string; significance: Significance };

/**
 * Map a controller event to an outcome-shaped progress fact — what surface is
 * being touched, not what was found there. Content never appears in a progress
 * signal; it appears only in the final spoken answer.
 */
function classify(event: AgentControllerEvent): Candidate | undefined {
  switch (event.type) {
    case "tool_start": {
      const name = event.toolName.replace(/[_-]/g, " ").trim();
      return name
        ? { text: `You are now working on: ${name}.`, significance: "routine" }
        : undefined;
    }
    case "subagent_start": {
      const task = event.task?.trim();
      return task ? { text: `You are now: ${task}.`, significance: "notable" } : undefined;
    }
    default:
      return undefined;
  }
}

export function createProgressGate(options?: { now?: () => number }): ProgressGate {
  const now = options?.now ?? Date.now;
  // Before anything has been said there is no silence to protect, so the first
  // candidate always passes.
  let lastSpokenAt = -Infinity;
  let lastText: string | undefined;

  return {
    admit(event: AgentControllerEvent): string | undefined {
      const candidate = classify(event);
      if (!candidate) return undefined;

      if (now() - lastSpokenAt < QUIET_MS[candidate.significance]) return undefined;

      // Saying the same sentence twice reads as a stuck record even when the
      // window has genuinely elapsed.
      if (candidate.text === lastText) return undefined;

      lastSpokenAt = now();
      lastText = candidate.text;
      return candidate.text;
    },
  };
}
