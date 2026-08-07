import { describe, expect, test } from "vitest";

import {
  FEATURE_BINS,
  NEUTRAL_SCORE,
  assembleTemplates,
  cosineSimilarity,
  extractFeatures,
  scoreTake,
} from "./wake-score.js";

/**
 * The scorer seam, checked without a microphone and without a browser.
 *
 * The pure module runs anywhere, so these tests are about its contracts: a
 * fixed-length feature vector regardless of input length, a sensible similarity
 * ordering (identical > similar > different), and the enrollment orchestration
 * that the UI and the enroll CLI both drive. When the real MFCC/DTW matcher
 * lands behind these signatures, these tests keep the seam honest.
 */

/** A synthetic envelope: a rising ramp shaped into PCM16, so it is deterministic. */
const ramp = (length: number, from = 1000, to = 16000) => {
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i += 1) samples[i] = Math.round(from + ((to - from) * i) / length);
  return samples;
};

const silence = (length: number) => new Int16Array(length);

const noise = (length: number) => {
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i += 1) samples[i] = Math.round(1000 * Math.sin(i / 9));
  return samples;
};

describe("extractFeatures", () => {
  test("produces a fixed-length vector regardless of input length", () => {
    const short = extractFeatures(ramp(8000), 16000);
    const long = extractFeatures(ramp(40000), 16000);
    expect(short.length).toBe(FEATURE_BINS);
    expect(long.length).toBe(FEATURE_BINS);
  });

  test("is deterministic — the same input twice is the same vector", () => {
    const a = extractFeatures(ramp(16000), 16000);
    const b = extractFeatures(ramp(16000), 16000);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  test("a ramp produces a monotonically non-decreasing envelope", () => {
    // A rising signal, normalised, must rise (or stay flat) across the bins.
    const features = extractFeatures(ramp(16000), 16000);
    for (let i = 1; i < features.length; i += 1) expect(features[i]).toBeGreaterThanOrEqual(features[i - 1]);
  });

  test("silence produces an all-zero vector", () => {
    const features = extractFeatures(silence(16000), 16000);
    expect(Array.from(features).every((v) => v === 0)).toBe(true);
  });
});

describe("cosineSimilarity", () => {
  test("identical vectors score 1", () => {
    const v = extractFeatures(ramp(16000), 16000);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  test("a zero vector against anything is 0", () => {
    expect(cosineSimilarity(new Float32Array(32), extractFeatures(ramp(16000), 16000))).toBe(0);
  });
});

describe("scoreTake", () => {
  test("no enrolled templates returns the neutral baseline", () => {
    expect(scoreTake(extractFeatures(ramp(16000), 16000), [])).toBe(NEUTRAL_SCORE);
  });

  test("identical features against the matching template score 1", () => {
    const features = extractFeatures(ramp(16000), 16000);
    const template = { features: Array.from(features) };
    expect(scoreTake(features, [template])).toBeCloseTo(1, 5);
  });

  test("a take scores higher against a matching template than against a different sound", () => {
    const rampFeatures = extractFeatures(ramp(16000), 16000);
    const rampTemplate = { features: Array.from(rampFeatures) };
    const noiseTemplate = { features: Array.from(extractFeatures(noise(16000), 16000)) };
    // The same ramp take, scored against each.
    const againstRamp = scoreTake(rampFeatures, [rampTemplate]);
    const againstNoise = scoreTake(rampFeatures, [noiseTemplate]);
    expect(againstRamp).toBeGreaterThan(againstNoise);
  });

  test("the best match wins when several templates are enrolled", () => {
    const rampFeatures = extractFeatures(ramp(16000), 16000);
    const templates = [
      { features: Array.from(extractFeatures(noise(16000), 16000)) },
      { features: Array.from(rampFeatures) }, // the match
      { features: Array.from(extractFeatures(silence(16000), 16000)) },
    ];
    expect(scoreTake(rampFeatures, templates)).toBeCloseTo(1, 5);
  });
});

describe("assembleTemplates", () => {
  test("three takes yield three templates with correct metadata", () => {
    const { templates } = assembleTemplates(
      [ramp(16000), ramp(16000), ramp(16000)],
      { phrase: "hey mastra", sampleRate: 16000 },
    );
    expect(templates).toHaveLength(3);
    for (const t of templates) {
      expect(t.phrase).toBe("hey mastra");
      expect(t.sampleRate).toBe(16000);
      expect(typeof t.createdAt).toBe("string");
      expect(t.features).toHaveLength(FEATURE_BINS);
      expect(t.features.every((f) => typeof f === "number" && Number.isFinite(f))).toBe(true);
    }
  });

  test("the first take scores neutral — nothing precedes it", () => {
    const { scores } = assembleTemplates(
      [ramp(16000), ramp(16000), ramp(16000)],
      { phrase: "hey mastra", sampleRate: 16000 },
    );
    expect(scores).toHaveLength(3);
    expect(scores[0]).toBe(NEUTRAL_SCORE);
  });

  test("a consistent second take scores higher than a divergent one", () => {
    // Two identical ramps then an identical ramp again — the third should score
    // high against the first two. Then compare against a noise take.
    const consistent = assembleTemplates(
      [ramp(16000), ramp(16000), ramp(16000)],
      { phrase: "hey mastra", sampleRate: 16000 },
    );
    const divergent = assembleTemplates(
      [ramp(16000), noise(16000), noise(16000)],
      { phrase: "hey mastra", sampleRate: 16000 },
    );
    // Second take: identical ramp (high) vs noise (low).
    expect(consistent.scores[1]).toBeGreaterThan(divergent.scores[1]);
    // All scores stay within [0, 1].
    for (const score of [...consistent.scores, ...divergent.scores]) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});
