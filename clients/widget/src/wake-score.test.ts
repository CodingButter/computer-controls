import { describe, expect, test } from "vitest";

import {
  NEUTRAL_SCORE,
  SCORE_FLOOR_DISTANCE,
  assembleTemplates,
  extractFeatures,
  scoreFromDistance,
  scoreTake,
} from "./wake-score.js";
import { ENROLLED_WAKE_WEIGHT } from "./vendor/live/fingerprint.js";

/**
 * The scorer, checked without a microphone and without a browser.
 *
 * The module is now a thin adapter over the hub's MFCC/DTW matcher — the same
 * arithmetic the wake gate runs — so these tests are about the contracts the UI
 * and the storage depend on: a take resolves to a sequence of frames, a score
 * says how close a take is to what is already enrolled, and every stored
 * template carries the weight the matcher will divide its distance by.
 */

/** A synthetic signal: a rising ramp shaped into PCM16, so it is deterministic. */
const ramp = (length: number, from = 1000, to = 16000) => {
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i += 1) samples[i] = Math.round(from + ((to - from) * i) / length);
  return samples;
};

/** A voiced-ish tone: a periodic signal, which is what MFCC is built to describe. */
const tone = (length: number, hz = 180, amplitude = 8000) => {
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / 16000));
  }
  return samples;
};

const noise = (length: number) => {
  const samples = new Int16Array(length);
  let seed = 7;
  for (let i = 0; i < length; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    samples[i] = (seed % 16000) - 8000;
  }
  return samples;
};

describe("extractFeatures", () => {
  test("resolves a take into a sequence of frames, one per hop", () => {
    // A phrase is a shape in time. The envelope version flattened that away,
    // which is exactly what made it useless.
    const frames = extractFeatures(tone(16000), 16000);
    expect(frames.length).toBeGreaterThan(50);
    for (const frame of frames) expect(frame).toHaveLength(13);
  });

  test("a longer take produces more frames", () => {
    const short = extractFeatures(tone(8000), 16000);
    const long = extractFeatures(tone(24000), 16000);
    expect(long.length).toBeGreaterThan(short.length);
  });

  test("is deterministic — the same input twice is the same frames", () => {
    expect(extractFeatures(tone(16000), 16000)).toEqual(extractFeatures(tone(16000), 16000));
  });

  test("every value is a finite number the storage can hold", () => {
    for (const frame of extractFeatures(ramp(16000), 16000)) {
      for (const value of frame) expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe("scoreFromDistance", () => {
  test("a perfect match scores 1", () => {
    expect(scoreFromDistance(0)).toBe(1);
  });

  test("a take sitting exactly on the gate's threshold scores a half", () => {
    // The number on screen is calibrated against the number the gate uses:
    // 0.5 is the bar, not an arbitrary midpoint.
    expect(scoreFromDistance(SCORE_FLOOR_DISTANCE / 2)).toBeCloseTo(0.5, 10);
  });

  test("nothing ever escapes [0, 1]", () => {
    expect(scoreFromDistance(SCORE_FLOOR_DISTANCE * 10)).toBe(0);
    expect(scoreFromDistance(Infinity)).toBe(0);
    expect(scoreFromDistance(-1)).toBe(1);
  });
});

describe("scoreTake", () => {
  test("no enrolled templates returns the neutral baseline", () => {
    expect(scoreTake(extractFeatures(tone(16000), 16000), [])).toBe(NEUTRAL_SCORE);
  });

  test("a take against its own frames scores 1", () => {
    const frames = extractFeatures(tone(16000), 16000);
    expect(scoreTake(frames, [{ frames }])).toBeCloseTo(1, 5);
  });

  test("a take scores higher against a matching template than against a different sound", () => {
    const toneFrames = extractFeatures(tone(16000), 16000);
    const against = (template: number[][]) => scoreTake(toneFrames, [{ frames: template }]);
    expect(against(extractFeatures(tone(16000), 16000))).toBeGreaterThan(
      against(extractFeatures(noise(16000), 16000)),
    );
  });

  test("the best match wins when several templates are enrolled", () => {
    const toneFrames = extractFeatures(tone(16000), 16000);
    const templates = [
      { frames: extractFeatures(noise(16000), 16000) },
      { frames: toneFrames }, // the match
      { frames: extractFeatures(ramp(16000), 16000) },
    ];
    expect(scoreTake(toneFrames, templates)).toBeCloseTo(1, 5);
  });

  test("a template with no frames is skipped rather than crashed on", () => {
    const frames = extractFeatures(tone(16000), 16000);
    expect(scoreTake(frames, [{ frames: [] }, { frames }])).toBeCloseTo(1, 5);
  });
});

describe("assembleTemplates", () => {
  test("three takes yield three templates with the metadata storage validates", () => {
    const { templates } = assembleTemplates([tone(16000), tone(16000), tone(16000)], {
      phrase: "hey mastra",
      sampleRate: 16000,
    });
    expect(templates).toHaveLength(3);
    for (const t of templates) {
      expect(t.phrase).toBe("hey mastra");
      expect(t.sampleRate).toBe(16000);
      expect(typeof t.createdAt).toBe("string");
      expect(t.frames.length).toBeGreaterThan(0);
      expect(t.frames[0]).toHaveLength(13);
    }
  });

  test("every enrolled template carries the matcher's weight", () => {
    // The gate reads the weight off the template instead of guessing where a
    // template came from, so enrollment has to write it.
    const { templates } = assembleTemplates([tone(16000)], {
      phrase: "hey mastra",
      sampleRate: 16000,
    });
    expect(templates[0].weight).toBe(ENROLLED_WAKE_WEIGHT);
  });

  test("the first take scores neutral — nothing precedes it", () => {
    const { scores } = assembleTemplates([tone(16000), tone(16000)], {
      phrase: "hey mastra",
      sampleRate: 16000,
    });
    expect(scores[0]).toBe(NEUTRAL_SCORE);
  });

  test("a consistent second take scores higher than a divergent one", () => {
    const consistent = assembleTemplates([tone(16000), tone(16000)], {
      phrase: "hey mastra",
      sampleRate: 16000,
    });
    const divergent = assembleTemplates([tone(16000), noise(16000)], {
      phrase: "hey mastra",
      sampleRate: 16000,
    });
    expect(consistent.scores[1]).toBeGreaterThan(divergent.scores[1]);
    for (const score of [...consistent.scores, ...divergent.scores]) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});
