import { describe, expect, it } from "vitest";

import { ENROLLED_WAKE_WEIGHT } from "../live/fingerprint.ts";
import {
  assembleTemplates,
  extractFeatures,
  NEUTRAL_SCORE,
  scoreFromDistance,
  scoreTake,
  SCORE_FLOOR_DISTANCE,
  TARGET_TAKES,
} from "./enrollment.ts";

const RATE = 16_000;

/** A repeatable "phrase": a tone burst with a shaped envelope, in PCM16. */
function utterance(seed: number, length = RATE / 2): Int16Array {
  const out = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / RATE;
    const envelope = Math.sin((Math.PI * i) / length) ** 2;
    out[i] = Math.round(
      12_000 * envelope * Math.sin(2 * Math.PI * (180 + seed * 40) * t) +
        3_000 * envelope * Math.sin(2 * Math.PI * (900 + seed * 130) * t),
    );
  }
  return out;
}

describe("turning a take into a template", () => {
  it("produces a sequence of frames, not one flattened vector", () => {
    const frames = extractFeatures(utterance(0), RATE);
    expect(frames.length).toBeGreaterThan(10);
    expect(frames[0]).toHaveLength(13);
    expect(frames.every((f) => f.every(Number.isFinite))).toBe(true);
  });

  it("hands back plain arrays, because these are about to become JSON", () => {
    const frames = extractFeatures(utterance(0), RATE);
    expect(Array.isArray(frames[0])).toBe(true);
    expect(JSON.parse(JSON.stringify(frames))[0]).toEqual(frames[0]);
  });

  it("accepts plain numbers as readily as PCM16", () => {
    const samples = Array.from(utterance(1));
    expect(extractFeatures(samples, RATE)).toEqual(extractFeatures(utterance(1), RATE));
  });
});

describe("the score under a take", () => {
  it("is calibrated against the gate: on the threshold reads as half", () => {
    expect(scoreFromDistance(SCORE_FLOOR_DISTANCE / 2)).toBeCloseTo(0.5, 6);
    expect(scoreFromDistance(0)).toBe(1);
    expect(scoreFromDistance(SCORE_FLOOR_DISTANCE * 2)).toBe(0);
    expect(scoreFromDistance(Number.NaN)).toBe(0);
  });

  it("is neutral for the first take, because there is nothing to be consistent with", () => {
    expect(scoreTake(extractFeatures(utterance(0), RATE), [])).toBe(NEUTRAL_SCORE);
  });

  it("scores a repeat of the same utterance higher than a different one", () => {
    const enrolled = [{ frames: extractFeatures(utterance(0), RATE) }];
    const same = scoreTake(extractFeatures(utterance(0), RATE), enrolled);
    const other = scoreTake(extractFeatures(utterance(6), RATE), enrolled);
    expect(same).toBeGreaterThan(other);
  });

  it("takes the best match rather than the average, so one good template is enough", () => {
    const enrolled = [
      { frames: extractFeatures(utterance(9), RATE) },
      { frames: extractFeatures(utterance(0), RATE) },
    ];
    expect(scoreTake(extractFeatures(utterance(0), RATE), enrolled)).toBe(
      scoreTake(extractFeatures(utterance(0), RATE), [enrolled[1]!]),
    );
  });
});

describe("assembling an enrolment", () => {
  it("returns one template and one score per take", () => {
    const takes = [utterance(0), utterance(0), utterance(0)];
    const { templates, scores } = assembleTemplates(takes, { phrase: "hey mastra", sampleRate: RATE });
    expect(templates).toHaveLength(TARGET_TAKES);
    expect(scores).toHaveLength(TARGET_TAKES);
    expect(scores[0]).toBe(NEUTRAL_SCORE);
    expect(scores.every((s) => s >= 0 && s <= 1)).toBe(true);
  });

  it("marks every template as the person's own, so the gate weighs it above the factory set", () => {
    const { templates } = assembleTemplates([utterance(0)], {
      phrase: "hey mastra",
      sampleRate: RATE,
    });
    expect(templates[0]?.weight).toBe(ENROLLED_WAKE_WEIGHT);
    expect(templates[0]?.phrase).toBe("hey mastra");
    expect(Date.parse(templates[0]?.createdAt ?? "")).not.toBeNaN();
  });

  it("scores a consistent set above a set that wandered", () => {
    const consistent = assembleTemplates([utterance(0), utterance(0), utterance(0)], {
      phrase: "hey mastra",
      sampleRate: RATE,
    });
    const wandering = assembleTemplates([utterance(0), utterance(7), utterance(14)], {
      phrase: "hey mastra",
      sampleRate: RATE,
    });
    const last = (s: number[]) => s[s.length - 1] ?? 0;
    expect(last(consistent.scores)).toBeGreaterThan(last(wandering.scores));
  });
});
