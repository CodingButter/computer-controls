import { TARGET_TAKES } from "@hub/wake/enrollment";
import { expect, test } from "vitest";

import {
  COUNTDOWN_FROM,
  IDLE,
  afterTake,
  afterTick,
  isRunning,
  startAt,
  walkthroughMessage,
  walkthroughProgress,
  type Walkthrough,
} from "@/lib/wake-walkthrough";

/**
 * One press has to reach the end on its own. These tests drive the whole run
 * the way the component does — tick, take, tick — and count what a person would
 * have had to do by hand.
 */

/** Run the machine to a standstill, reporting what it did on the way. */
function walk(from: Walkthrough = startAt(0)) {
  const recorded: number[] = [];
  const ticksPerTake: number[] = [];
  let phase = from;
  let ticks = 0;

  for (let step = 0; step < 1_000 && phase.kind !== "done"; step += 1) {
    if (phase.kind === "recording") {
      recorded.push(phase.slot);
      ticksPerTake.push(ticks);
      ticks = 0;
      phase = afterTake(recorded.length);
      continue;
    }
    ticks += 1;
    phase = afterTick(phase);
  }

  return { phase, recorded, ticksPerTake };
}

test("one start walks every take without another press", () => {
  const { phase, recorded } = walk();
  expect(phase).toEqual({ kind: "done" });
  expect(recorded).toEqual(Array.from({ length: TARGET_TAKES }, (_, i) => i));
});

test("every take gets its own countdown, the same length", () => {
  const { ticksPerTake } = walk();
  expect(ticksPerTake).toHaveLength(TARGET_TAKES);
  expect(new Set(ticksPerTake)).toEqual(new Set([COUNTDOWN_FROM]));
});

test("the countdown ends by opening the microphone, not by showing a zero", () => {
  let phase: Walkthrough = startAt(2);
  for (let i = 0; i < COUNTDOWN_FROM - 1; i += 1) phase = afterTick(phase);
  expect(phase).toEqual({ kind: "countdown", slot: 2, remaining: 1 });
  expect(afterTick(phase)).toEqual({ kind: "recording", slot: 2 });
});

test("re-recording one take of a full set finishes instead of starting over", () => {
  expect(afterTake(TARGET_TAKES)).toEqual({ kind: "done" });
});

test("a take collected mid-walkthrough queues the first slot still empty", () => {
  expect(afterTake(1)).toEqual({ kind: "countdown", slot: 1, remaining: COUNTDOWN_FROM });
});

test("a tick is ignored by every phase that is not counting down", () => {
  expect(afterTick(IDLE)).toEqual(IDLE);
  expect(afterTick({ kind: "recording", slot: 0 })).toEqual({ kind: "recording", slot: 0 });
  expect(afterTick({ kind: "done" })).toEqual({ kind: "done" });
});

test("the microphone counts as in use from the countdown, not from the first sample", () => {
  expect(isRunning(startAt(0))).toBe(true);
  expect(isRunning({ kind: "recording", slot: 0 })).toBe(true);
  expect(isRunning(IDLE)).toBe(false);
  expect(isRunning({ kind: "done" })).toBe(false);
});

test("what it says tracks what it is doing", () => {
  expect(walkthroughMessage(startAt(0), "hey mastra")).toMatch(/recording in 2/i);
  expect(walkthroughMessage({ kind: "countdown", slot: 0, remaining: 1 }, "x")).toMatch(/ready/i);
  expect(walkthroughMessage({ kind: "recording", slot: 0 }, "hey mastra")).toContain(
    "Say “hey mastra” now.",
  );
  expect(walkthroughMessage({ kind: "done" }, "x")).toMatch(/re-record/i);
  expect(walkthroughMessage(IDLE, "hey mastra")).toMatch(/press start/i);
});

test("progress reads as the take in hand, and never runs past the end", () => {
  expect(walkthroughProgress(IDLE, 0)).toEqual({ step: 0, of: TARGET_TAKES });
  expect(walkthroughProgress(startAt(1), 1)).toEqual({ step: 2, of: TARGET_TAKES });
  expect(walkthroughProgress({ kind: "recording", slot: 4 }, 4)).toEqual({
    step: 5,
    of: TARGET_TAKES,
  });
  expect(walkthroughProgress({ kind: "done" }, TARGET_TAKES)).toEqual({
    step: TARGET_TAKES,
    of: TARGET_TAKES,
  });
});
