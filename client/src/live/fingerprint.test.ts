/**
 * The matcher is pure math, so the tests are property tests: what MFCC
 * promises about any utterance, what subsequence DTW promises about any pair
 * of sequences, and what the detector promises about any template bank. No
 * audio files — synthesized tones and noise are enough to pin every property,
 * and the real corpus gets its say in the calibration script, where the
 * verdict actually lives.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_WAKE_THRESHOLD,
  ENROLLED_WAKE_WEIGHT,
  createFingerprintDetector,
  mfcc,
  subsequenceDtw,
  type WakeTemplate,
} from "./fingerprint.ts";

const SAMPLE_RATE = 16_000;
const FRAME_LENGTH = 400; // 25ms at 16k
const HOP_LENGTH = 160; // 10ms at 16k

/** A pure tone, `ms` long. */
function tone(frequencyHz: number, ms: number, amplitude = 0.5): Int16Array {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * frequencyHz * i) / SAMPLE_RATE));
  }
  return samples;
}

/** Deterministic pseudo-noise — no Math.random, so every run sees the same bytes. */
function noise(ms: number, seed = 1234): Int16Array {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  let state = seed;
  for (let i = 0; i < samples.length; i++) {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    samples[i] = (state % 16384) | 0;
  }
  return samples;
}

/** A "phrase": a distinctive tone sweep the tests can plant inside longer audio. */
function sweep(ms: number): Int16Array {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let i = 0; i < samples.length; i++) {
    const progress = i / samples.length;
    const hz = 300 + 1200 * progress;
    samples[i] = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE));
  }
  return samples;
}

function concat(...parts: Int16Array[]): Int16Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
}

describe("mfcc", () => {
  it("produces the arithmetic frame count for the hop", () => {
    const samples = tone(440, 1000);
    const frames = mfcc(samples, SAMPLE_RATE);
    const expected = Math.floor((samples.length - FRAME_LENGTH) / HOP_LENGTH) + 1;
    expect(frames.length).toBe(expected);
    for (const frame of frames) expect(frame.length).toBe(13);
  });

  it("returns no frames for audio shorter than one frame", () => {
    expect(mfcc(new Int16Array(FRAME_LENGTH - 1), SAMPLE_RATE)).toEqual([]);
    expect(mfcc(new Int16Array(0), SAMPLE_RATE)).toEqual([]);
  });

  it("is mean-normalized: every dimension sums to zero across the utterance", () => {
    const frames = mfcc(concat(tone(300, 200), tone(1200, 200)), SAMPLE_RATE);
    for (let d = 0; d < 13; d++) {
      let sum = 0;
      for (const frame of frames) sum += frame[d];
      expect(Math.abs(sum / frames.length)).toBeLessThan(1e-4);
    }
  });

  it("distinguishes silence from a tone", () => {
    // CMN centres each utterance, so the comparison is between the two
    // utterances' shapes via DTW, not raw coefficient values.
    const quiet = mfcc(silence(500), SAMPLE_RATE);
    const loud = mfcc(tone(440, 500), SAMPLE_RATE);
    const self = subsequenceDtw(loud, loud);
    const cross = subsequenceDtw(quiet, loud);
    expect(cross).toBeGreaterThan(self + 1);
  });
});

describe("subsequenceDtw", () => {
  it("scores an identical sequence at (near) zero", () => {
    const frames = mfcc(sweep(400), SAMPLE_RATE);
    expect(subsequenceDtw(frames, frames)).toBeLessThan(1e-9);
  });

  it("finds a template embedded in the middle of a longer query", () => {
    const phrase = sweep(400);
    const template = mfcc(phrase, SAMPLE_RATE);
    const embedded = mfcc(concat(noise(600, 7), phrase, noise(600, 99)), SAMPLE_RATE);
    const alone = subsequenceDtw(mfcc(phrase, SAMPLE_RATE), template);
    const inContext = subsequenceDtw(embedded, template);
    // Embedding costs a little (CMN shifts with the surrounding audio), but
    // the phrase must still score far closer than unrelated audio does.
    const unrelated = subsequenceDtw(mfcc(noise(1600, 5), SAMPLE_RATE), template);
    expect(inContext).toBeLessThan(unrelated);
    expect(inContext - alone).toBeLessThan(unrelated - alone);
  });

  it("scores unrelated audio far from the template", () => {
    const template = mfcc(sweep(400), SAMPLE_RATE);
    const other = mfcc(noise(1000, 42), SAMPLE_RATE);
    expect(subsequenceDtw(other, template)).toBeGreaterThan(subsequenceDtw(template, template) + 1);
  });

  it("answers Infinity for an empty side", () => {
    const frames = mfcc(tone(440, 300), SAMPLE_RATE);
    expect(subsequenceDtw([], frames)).toBe(Infinity);
    expect(subsequenceDtw(frames, [])).toBe(Infinity);
  });

  it("accepts plain number[][] — the shape templates arrive in from JSON", () => {
    const frames = mfcc(sweep(300), SAMPLE_RATE);
    const asArrays = frames.map((f) => Array.from(f));
    expect(subsequenceDtw(frames, asArrays)).toBeLessThan(1e-9);
  });
});

describe("createFingerprintDetector", () => {
  const phrase = sweep(400);
  const phraseTemplate = (): WakeTemplate => ({
    id: "test-phrase",
    frames: mfcc(phrase, SAMPLE_RATE).map((f) => Array.from(f)),
  });

  it("never matches with an empty template bank — deaf, not trigger-happy", () => {
    const detector = createFingerprintDetector([]);
    expect(detector.heard({ samples: phrase, sampleRate: SAMPLE_RATE })).toBe(false);
  });

  it("never matches an utterance shorter than one frame", () => {
    const detector = createFingerprintDetector([phraseTemplate()], { threshold: 1e9 });
    expect(detector.heard({ samples: new Int16Array(10), sampleRate: SAMPLE_RATE })).toBe(false);
  });

  it("hears its own template and stays deaf to noise at the same threshold", () => {
    const detector = createFingerprintDetector([phraseTemplate()], { threshold: 0.5 });
    expect(detector.heard({ samples: phrase, sampleRate: SAMPLE_RATE })).toBe(true);
    expect(detector.heard({ samples: noise(1000, 77), sampleRate: SAMPLE_RATE })).toBe(false);
  });

  it("is monotonic in the threshold: a stricter bar never hears more", () => {
    const utterance = { samples: concat(noise(300, 3), phrase, noise(300, 9)), sampleRate: SAMPLE_RATE };
    const template = phraseTemplate();
    const strict = createFingerprintDetector([template], { threshold: 1e-6 });
    const loose = createFingerprintDetector([template], { threshold: 1e9 });
    const strictHears = strict.heard(utterance);
    const looseHears = loose.heard(utterance);
    expect(looseHears || !strictHears).toBe(true);
    expect(looseHears).toBe(true);
  });

  it("lets an enrolled template's weight lower its own bar and nobody else's", () => {
    // Pick a threshold just below the true distance: unweighted misses,
    // ENROLLED_WAKE_WEIGHT (>1) divides the distance under the bar.
    const template = phraseTemplate();
    const query = mfcc(concat(noise(200, 11), phrase), SAMPLE_RATE);
    const distance = subsequenceDtw(query, template.frames);
    expect(distance).toBeGreaterThan(0);
    const threshold = distance * 0.95;
    const utterance = { samples: concat(noise(200, 11), phrase), sampleRate: SAMPLE_RATE };
    const factoryOnly = createFingerprintDetector([template], { threshold });
    expect(factoryOnly.heard(utterance)).toBe(false);
    const enrolled = createFingerprintDetector([{ ...template, weight: ENROLLED_WAKE_WEIGHT }], { threshold });
    expect(ENROLLED_WAKE_WEIGHT).toBeGreaterThan(1);
    expect(enrolled.heard(utterance)).toBe(true);
  });

  it("ships a positive default threshold the calibration chose", () => {
    expect(DEFAULT_WAKE_THRESHOLD).toBeGreaterThan(0);
  });

  it("reset is callable and changes nothing — the detector is stateless", () => {
    const detector = createFingerprintDetector([phraseTemplate()], { threshold: 0.5 });
    const utterance = { samples: phrase, sampleRate: SAMPLE_RATE };
    expect(detector.heard(utterance)).toBe(true);
    detector.reset();
    expect(detector.heard(utterance)).toBe(true);
  });

  it("scores 40 templates against a 15s utterance inside the budget", () => {
    // The number is REPORTED for the record; the assertion is a generous
    // 1000ms bound — a tight wall-clock in a unit test is a flake on a
    // loaded machine, and this repo already carries one recorded flake.
    const templates: WakeTemplate[] = [];
    for (let i = 0; i < 40; i++) {
      const t = mfcc(sweep(350 + (i % 7) * 25), SAMPLE_RATE).map((f) => Array.from(f));
      templates.push({ id: `t${i}`, frames: t });
    }
    const detector = createFingerprintDetector(templates);
    const utterance = { samples: concat(noise(7000, 21), phrase, noise(7600, 63)), sampleRate: SAMPLE_RATE };
    const started = performance.now();
    detector.heard(utterance);
    const elapsedMs = performance.now() - started;
    // eslint-disable-next-line no-console
    console.info(`[fingerprint timing] 40 templates x 15s utterance: ${elapsedMs.toFixed(1)}ms`);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
