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

/**
 * The rules a person meets at the microphone: what is reachable, what a score
 * means, and what happens when they say it differently the second time.
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
      recording={null}
      saving={false}
      saved={null}
      problem={null}
      onRecord={() => {}}
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

test("save is out of reach until every take exists", () => {
  const full = Array.from({ length: TARGET_TAKES }, () => tone(1));

  // With a take missing, every take button is reachable and the only disabled
  // control on the page is Save.
  const short = view({ takes: takesOf(...full.slice(1)) });
  expect(short.match(/disabled=""/g)).toHaveLength(1);

  // With the set complete, nothing on the page is out of reach.
  const complete = view({ takes: takesOf(...full) });
  expect(complete.match(/disabled=""/g)).toBeNull();

  // And with none recorded, every take after the first is out of reach too,
  // alongside Save: an enrolment is walked through in order.
  expect(view().match(/disabled=""/g)).toHaveLength(TARGET_TAKES);
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

test("re-recording a take drops the takes that were scored against the old one", () => {
  const three = takesOf(tone(1), tone(1), tone(1));
  expect(takesAfterRecording(three, 1, tone(2))).toHaveLength(2);
  // And re-recording the last take keeps the others.
  expect(takesAfterRecording(three, 2, tone(2))).toHaveLength(3);
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
  expect(view({ recording: 0 })).toContain(`Say “${ENROLL_PHRASE}” now.`);
});
