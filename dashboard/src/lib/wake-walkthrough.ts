/**
 * The shape of a guided enrolment, as arithmetic.
 *
 * Enrolment used to be a column of buttons: one per take, pressed in order, and
 * the person's hands were on the mouse when they should have been free to say a
 * phrase naturally. A walkthrough presses those buttons for them — count down,
 * open the microphone, close it, move to the next — and that sequence is the
 * thing worth being sure about.
 *
 * So it lives here, as pure functions over a phase, rather than inside a
 * component's effects. The dashboard's tests run in node with no DOM and no
 * fake clock over React; a state machine tangled into `useEffect` could only be
 * checked by rendering it, which this suite cannot do. Written this way the
 * whole run — every countdown tick, every take, the finish — is driven in a
 * loop by a test in microseconds, and the component is left holding only the
 * timers.
 *
 * Timing lives beside the microphone, in this directory, and not in
 * `wake/enrollment.ts`. That module is numbers in and numbers out; it does not
 * know what a second is and should not learn.
 */

import { TARGET_TAKES } from "@hub/wake/enrollment";

/** Seconds of warning before the microphone opens. Enough to draw a breath. */
export const COUNTDOWN_FROM = 3;

/** One tick, one second. A countdown that is not seconds is a progress bar. */
export const COUNTDOWN_TICK_MS = 1_000;

export type Walkthrough =
  | { kind: "idle" }
  | { kind: "countdown"; slot: number; remaining: number }
  | { kind: "recording"; slot: number }
  | { kind: "done" };

export const IDLE: Walkthrough = { kind: "idle" };

/** Begin the run-up to one take. */
export function startAt(slot: number): Walkthrough {
  return { kind: "countdown", slot, remaining: COUNTDOWN_FROM };
}

/**
 * One second later.
 *
 * The last tick does not land on zero and wait to be noticed — it opens the
 * microphone, because "0" on screen with nothing recording is a countdown that
 * lied.
 */
export function afterTick(phase: Walkthrough): Walkthrough {
  if (phase.kind !== "countdown") return phase;
  if (phase.remaining <= 1) return { kind: "recording", slot: phase.slot };
  return { kind: "countdown", slot: phase.slot, remaining: phase.remaining - 1 };
}

/**
 * Where the walkthrough goes when a take has been collected.
 *
 * It asks how many takes exist, not which slot was just filled, and that is
 * what makes re-recording one take cheap: replacing take two of a full set
 * leaves the set full, so this returns `done` instead of marching through
 * three, four and five again. Mid-walkthrough the same question means "the
 * first slot still empty", which is the next one to record.
 */
export function afterTake(takesRecorded: number): Walkthrough {
  if (takesRecorded >= TARGET_TAKES) return { kind: "done" };
  return startAt(takesRecorded);
}

/** Whether the microphone is in use, or about to be. */
export function isRunning(phase: Walkthrough): boolean {
  return phase.kind === "countdown" || phase.kind === "recording";
}

/** What the person is told, at the moment they need to know it. */
export function walkthroughMessage(phase: Walkthrough, phrase: string): string {
  switch (phase.kind) {
    case "idle":
      return `Press start, then say “${phrase}” each time you are asked.`;
    case "countdown":
      return phase.remaining === 1 ? "Get ready…" : `Recording in ${phase.remaining - 1}…`;
    case "recording":
      return `Say “${phrase}” now.`;
    case "done":
      return "That is every take. Save it, or re-record any one of them.";
  }
}

/**
 * How far through, counted the way a person counts: the take being worked on
 * now, out of the number wanted.
 *
 * Idle is step zero rather than one — nothing has been attempted yet — and the
 * finish reads as the full count rather than one past it.
 */
export function walkthroughProgress(
  phase: Walkthrough,
  takesRecorded: number,
): { step: number; of: number } {
  const of = TARGET_TAKES;
  switch (phase.kind) {
    case "idle":
      return { step: Math.min(takesRecorded, of), of };
    case "countdown":
    case "recording":
      return { step: phase.slot + 1, of };
    case "done":
      return { step: of, of };
  }
}
