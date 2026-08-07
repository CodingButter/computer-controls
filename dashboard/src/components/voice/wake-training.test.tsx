import { TARGET_TAKES } from "@hub/wake/enrollment";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import {
  ENROLL_PHRASE,
  WakeTrainingView,
  captureProblem,
  scoreLabel,
  takesAfterRecording,
  type Take,
} from "@/components/voice/wake-training";
import type { WakeTemplatesView } from "@/lib/hub";
import { IDLE, startAt } from "@/lib/wake-walkthrough";

/**
 * The page a person meets at the microphone: one control that starts the run,
 * what it says while it is running, what a score means, and what happens when
 * they say it differently the second time.
 */

const tone = (seed: number, length = 8_000) => {
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    samples[i] = Math.round(8_000 * Math.sin((i * (seed + 1)) / 40));
  }
  return samples;
};

const view = (props: Partial<Parameters<typeof WakeTrainingView>[0]> = {}) =>
  renderToStaticMarkup(
    <WakeTrainingView
      current={null}
      takes={[]}
      phase={IDLE}
      saving={false}
      saved={null}
      problem={null}
      onStart={() => {}}
      onStop={() => {}}
      onRerecord={() => {}}
      onSave={() => {}}
      {...props}
    />,
  );

const takesOf = (...samples: Int16Array[]): Take[] =>
  samples.reduce<Take[]>((acc, s, i) => takesAfterRecording(acc, i, s), []);

const stored = (count: number): WakeTemplatesView => ({
  phrase: ENROLL_PHRASE,
  enrolled: count > 0,
  templates: Array.from({ length: count }, (_, i) => ({
    id: `enrolled-${i + 1}`,
    phrase: ENROLL_PHRASE,
    createdAt: "2026-08-07T00:00:00.000Z",
    frames: [[0]],
    sampleRate: 16_000,
  })),
});

test("the page asks for the phrase and offers one row per take it wants", () => {
  const html = view();
  expect(html).toContain(ENROLL_PHRASE);
  expect(html.match(/data-testid="take-row"/g)).toHaveLength(TARGET_TAKES);
});

test("an untouched page offers exactly one thing to press: start", () => {
  const html = view();
  // No take has been recorded, so no row offers a re-record, and the only
  // enabled control is the one that begins the walkthrough.
  expect(html).not.toContain("Re-record");
  expect(html).toContain(">Start<");
  expect(html.match(/disabled=""/g)).toHaveLength(1);
  expect(html).toContain("Take 0 of " + TARGET_TAKES);
});

test("save is out of reach until every take exists", () => {
  const full = Array.from({ length: TARGET_TAKES }, () => tone(1));

  // With a take missing, Save is the only thing that cannot be pressed.
  const short = view({ takes: takesOf(...full.slice(1)) });
  expect(short.match(/disabled=""/g)).toHaveLength(1);

  // With the set complete, nothing on the page is out of reach.
  const complete = view({ takes: takesOf(...full) });
  expect(complete.match(/disabled=""/g)).toBeNull();
});

test("the walkthrough runs itself: no take button to press while it is going", () => {
  const midway = view({ takes: takesOf(tone(1)), phase: startAt(1) });
  // Stop is offered instead of start, and the one re-record that exists is out
  // of reach — the microphone is busy with take two.
  expect(midway).toContain(">Stop<");
  expect(midway).not.toContain(">Start<");
  expect(midway.match(/Re-record/g)).toHaveLength(2); // aria-label and label
  expect(midway.match(/disabled=""/g)).toHaveLength(2); // that re-record, and Save
  expect(midway).toContain("Take 2 of " + TARGET_TAKES);
});

test("a recorded take can be replaced once the microphone is free", () => {
  const done = view({ takes: takesOf(tone(1), tone(1)) });
  expect(done.match(/aria-label="Re-record take \d"/g)).toHaveLength(2);
  expect(done).toContain('aria-label="Re-record take 1"');
  expect(done).toContain('aria-label="Re-record take 2"');
});

test("a take is scored against the takes recorded before it, so the first shows none", () => {
  expect(view({ takes: takesOf(tone(1)) })).not.toContain('data-testid="take-score"');
  const two = view({ takes: takesOf(tone(1), tone(1)) });
  expect(two.match(/data-testid="take-score"/g)).toHaveLength(1);
});

test("saying it the same way scores higher than saying something else", () => {
  const same = takesOf(tone(1), tone(1))[1]!.score;
  const different = takesOf(tone(1), tone(9))[1]!.score;
  expect(same).toBeGreaterThan(different);
  expect(same).toBeGreaterThanOrEqual(0);
  expect(same).toBeLessThanOrEqual(1);
});

test("re-recording a take keeps the others and rescores what followed it", () => {
  const three = takesOf(tone(1), tone(1), tone(1));
  const replaced = takesAfterRecording(three, 1, tone(9));

  // Nobody loses the takes they already got right.
  expect(replaced).toHaveLength(3);
  expect(replaced[0]!.samples).toBe(three[0]!.samples);
  expect(replaced[2]!.samples).toBe(three[2]!.samples);

  // And the scores are recomputed rather than carried over. Take three is
  // scored against its *closest* neighbour, so with take one still identical to
  // it the number legitimately does not move; the case that proves rescoring is
  // the one where the replaced take is the only thing to compare against.
  const pair = takesOf(tone(1), tone(1));
  const rescored = takesAfterRecording(pair, 0, tone(9));
  expect(rescored[1]!.score).not.toBe(pair[1]!.score);
  expect(rescored[1]!.samples).toBe(pair[1]!.samples);
});

test("the score is described in the terms the gate decides in", () => {
  expect(scoreLabel(0, 0)).toMatch(/nothing to compare/i);
  expect(scoreLabel(0.9, 1)).toMatch(/sounds like the others/i);
  expect(scoreLabel(0.6, 1)).toMatch(/close enough/i);
  expect(scoreLabel(0.2, 1)).toMatch(/re-record/i);
});

test("a browser that refuses the microphone is explained, not swallowed", () => {
  const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
  expect(captureProblem(denied)).toMatch(/refused the microphone/i);
  expect(captureProblem(new Error("no such device"))).toBe("no such device");
  expect(captureProblem("something")).toMatch(/could not be opened/i);
});

test("a refusal from the hub is shown in the hub's own words", () => {
  const html = view({ problem: "Nothing usable in that body." });
  expect(html).toContain("Nothing usable in that body.");
  expect(html).toContain('data-testid="wake-problem"');
});

test("a saved enrolment says how many takes the hub kept", () => {
  expect(view({ saved: stored(3) })).toContain("Saved 3 takes");
});

test("an existing enrolment says that saving replaces it", () => {
  expect(view({ current: stored(3) })).toContain("3 takes already stored");
  expect(view({ current: null })).toContain("Nothing is enrolled yet");
});

test("while a take is recording the page says to speak now", () => {
  const html = view({ phase: { kind: "recording", slot: 0 } });
  expect(html).toContain(`Say “${ENROLL_PHRASE}” now.`);
  expect(html).toContain('data-testid="walkthrough-status"');
});

test("the countdown is on the page before the microphone opens", () => {
  const html = view({ phase: startAt(0) });
  expect(html).toMatch(/Recording in \d/);
  expect(html).not.toContain(`Say “${ENROLL_PHRASE}” now.`);
});

test("progress is reported the whole way, and stops at the last take", () => {
  expect(view({ phase: startAt(2), takes: takesOf(tone(1), tone(1)) })).toContain(
    `Take 3 of ${TARGET_TAKES}`,
  );
  const full = Array.from({ length: TARGET_TAKES }, () => tone(1));
  expect(view({ phase: { kind: "done" }, takes: takesOf(...full) })).toContain(
    `Take ${TARGET_TAKES} of ${TARGET_TAKES}`,
  );
});
