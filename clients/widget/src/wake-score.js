/**
 * The scorer: how a recorded take becomes a template, and how a take is scored
 * against the ones already enrolled.
 *
 * This was a stand-in — a 32-bin energy envelope compared by cosine similarity —
 * left behind the seam `extractFeatures`/`scoreTake`/`assembleTemplates` so the
 * real matcher could drop in without moving the UI or the storage. This is that
 * drop-in. The math now comes from the hub's own `fingerprint.js`: MFCC frames
 * matched by subsequence DTW, the same code the wake gate itself runs, vendored
 * byte-for-byte like every other live module. Enrollment scores a take with the
 * identical arithmetic that will later decide whether to open the gate, which is
 * the only way the number on screen means anything.
 *
 * Two things changed shape and could not be avoided. A take's features are a
 * SEQUENCE of frames, not one fixed-length vector — a phrase is a shape in
 * time, and flattening it away was exactly what made the envelope version
 * useless. And the score is now derived from a DTW distance rather than a
 * cosine, so it is calibrated against the wake threshold: 1.0 is a perfect
 * match, 0.5 is a take sitting exactly on the threshold the gate uses, 0 is
 * twice as far away as the gate would ever accept.
 *
 * The module stays pure. No filesystem, no network, no audio API — numbers in,
 * numbers out — so it runs identically in the renderer (live per-take scores),
 * in the Node enroll CLI, and in a test with no browser and no microphone.
 */

import {
  DEFAULT_WAKE_THRESHOLD,
  ENROLLED_WAKE_WEIGHT,
  mfcc,
  subsequenceDtw,
} from "./vendor/live/fingerprint.js";

/** The similarity returned when there is nothing to compare a take against. */
export const NEUTRAL_SCORE = 0;

/**
 * The distance at which a take scores zero.
 *
 * Twice the gate's threshold. It makes the displayed score readable against the
 * thing that actually matters: a take that would open the gate scores at or
 * above 0.5, and anything below that is a take the gate would refuse.
 */
export const SCORE_FLOOR_DISTANCE = DEFAULT_WAKE_THRESHOLD * 2;

/**
 * Turn raw PCM16 samples into the frame sequence the matcher compares.
 *
 * Delegates to the hub's MFCC so enrollment and the gate cannot drift apart.
 * The frames come back as plain arrays rather than the typed arrays the matcher
 * hands out: these end up in a JSON file, and a Float32Array serialises to an
 * object with numeric keys, which reads back as a template nothing recognises.
 *
 * @param {Int16Array | number[]} samples
 * @param {number} sampleRate
 * @returns {number[][]} one 13-dimensional frame per 10ms hop
 */
export function extractFeatures(samples, sampleRate) {
  const data = samples instanceof Int16Array ? samples : Int16Array.from(samples);
  return mfcc(data, sampleRate).map((frame) => Array.from(frame));
}

/**
 * Turn a DTW distance into a score in [0, 1], calibrated against the gate.
 *
 * @param {number} distance
 * @returns {number}
 */
export function scoreFromDistance(distance) {
  if (!Number.isFinite(distance)) return 0;
  const score = 1 - distance / SCORE_FLOOR_DISTANCE;
  return Math.max(0, Math.min(1, score));
}

/**
 * Score one take against the enrolled templates, or the neutral baseline when
 * nothing is enrolled yet.
 *
 * The best match is the one that counts: enrollment is asking "does this take
 * sound like the ones I already have?", and the closest answer is the answer.
 *
 * @param {number[][]} takeFrames
 * @param {{ frames: number[][] }[]} templates
 * @returns {number}
 */
export function scoreTake(takeFrames, templates) {
  if (!templates || templates.length === 0) return NEUTRAL_SCORE;
  if (!takeFrames || takeFrames.length === 0) return 0;
  let best = Infinity;
  for (const template of templates) {
    if (!template?.frames?.length) continue;
    const distance = subsequenceDtw(takeFrames, template.frames);
    if (distance < best) best = distance;
  }
  return scoreFromDistance(best);
}

/**
 * The pure enrollment orchestration: take raw takes, return ready-to-store
 * templates and the per-take score each earned.
 *
 * Each take is scored against the templates enrolled *before* it, then appended
 * — so the first take is scored against nothing (neutral), the second against
 * the first, the third against the first two. That mirrors what the user sees
 * live: a score that means "consistency against what you've recorded so far."
 *
 * Every stored template carries ENROLLED_WAKE_WEIGHT. That constant is the
 * matcher's, not this module's: it divides an enrolled template's distance at
 * match time, so the voice that lives with this machine clears the bar sooner
 * than a stranger's. Writing it in here means the gate reads the weight off the
 * template instead of guessing where a template came from.
 *
 * Both the UI and the enroll CLI drive enrollment through this one function, so
 * the orchestration is testable without a browser and without a microphone.
 *
 * @param {Array<Int16Array | number[]>} takes
 * @param {{ phrase: string, sampleRate: number }} meta
 * @returns {{ templates: { id: string, phrase: string, createdAt: string, frames: number[][], sampleRate: number, weight: number }[], scores: number[] }}
 */
export function assembleTemplates(takes, { phrase, sampleRate }) {
  const templates = [];
  const scores = [];
  for (const take of takes) {
    const frames = extractFeatures(take, sampleRate);
    scores.push(scoreTake(frames, templates));
    templates.push({
      id: `enrolled-${templates.length + 1}`,
      phrase,
      createdAt: new Date().toISOString(),
      frames,
      sampleRate,
      weight: ENROLLED_WAKE_WEIGHT,
    });
  }
  return { templates, scores };
}
