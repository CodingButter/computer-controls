/**
 * The scorer seam: how a recorded take becomes a template, and how a take is
 * scored against the enrolled set.
 *
 * This is a stand-in, not the agreed MFCC/DTW matcher. The MFCC/DTW design
 * (the real fingerprint wake-word core) and the factory template corpus are
 * separate work; they replace this module's internals through the same seam —
 * `extractFeatures` and `scoreTake` keep their signatures, and the template
 * shape on disk stays — so the UI and storage do not change when the real
 * matcher lands. What lives here today is enough to make enrollment
 * demonstrable and testable end to end: a length-invariant description of how a
 * take sounds, and an honest similarity score against what is enrolled so far.
 *
 * The module is pure on purpose. No filesystem, no network, no audio API — it
 * takes numbers in and gives numbers out — so it runs identically in the
 * renderer (live per-take scores), in a Node script (the WAV enroll CLI), and in
 * a test (no browser, no microphone).
 */

/**
 * How many windows a take is resolved into. Length-invariant: a 2.0s take and a
 * 2.5s take both produce this many values, so two recordings of the same phrase
 * land in the same shape regardless of exactly how long the person took.
 */
export const FEATURE_BINS = 32;

/** The similarity returned when there is nothing to compare a take against. */
export const NEUTRAL_SCORE = 0;

/**
 * Turn raw PCM16 samples into a fixed-length, normalised feature vector.
 *
 * The signal is windowed into `FEATURE_BINS` equal slices; each slice becomes
 * its root-mean-square amplitude; the vector is then min-max normalised so the
 * loudest slice is 1 and the quietest is 0. The result is the energy envelope of
 * the utterance — a coarse but real fingerprint of how this person paced and
 * stressed the phrase, which is enough to tell takes of the same voice apart
 * from silence and from a different sound entirely.
 *
 * @param {Int16Array | number[]} samples
 * @param {number} _sampleRate  kept in the signature so the real matcher (which
 *   is sample-rate-sensitive) can drop in unchanged.
 * @returns {Float32Array}
 */
export function extractFeatures(samples, _sampleRate) {
  const data = samples instanceof Int16Array ? samples : new Int16Array(samples);
  const bins = Math.max(1, FEATURE_BINS);
  const features = new Float32Array(bins);
  const slice = Math.max(1, Math.floor(data.length / bins));
  for (let i = 0; i < bins; i += 1) {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < slice; j += 1) {
      const index = i * slice + j;
      if (index >= data.length) break;
      const sample = data[index] / 32768;
      sum += sample * sample;
      count += 1;
    }
    features[i] = count > 0 ? Math.sqrt(sum / count) : 0;
  }
  return normalize(features);
}

/**
 * @param {Float32Array} vector
 * @returns {Float32Array}
 */
function normalize(vector) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of vector) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const range = max - min;
  const out = new Float32Array(vector.length);
  if (range === 0) return out;
  for (let i = 0; i < vector.length; i += 1) out[i] = (vector[i] - min) / range;
  return out;
}

/**
 * Cosine similarity in [-1, 1], clamped to [0, 1].
 *
 * Two identical envelopes score 1; two orthogonal ones score 0. A negative
 * similarity (an inverted envelope) is not meaningful for a wake score and is
 * clamped to the floor.
 *
 * @param {Float32Array | number[]} a
 * @param {Float32Array | number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return Math.max(0, dot / denom);
}

/**
 * Score one take against the enrolled templates, or the neutral baseline when
 * nothing is enrolled yet.
 *
 * The score is the highest similarity the take reaches against any one enrolled
 * template — the best match is the one that counts, because enrollment is
 * asking "does this take sound like the ones I already have?"
 *
 * @param {Float32Array | number[]} takeFeatures
 * @param {{ features: number[] }[]} templates
 * @returns {number}
 */
export function scoreTake(takeFeatures, templates) {
  if (!templates || templates.length === 0) return NEUTRAL_SCORE;
  let best = 0;
  for (const template of templates) {
    const similarity = cosineSimilarity(takeFeatures, template.features);
    if (similarity > best) best = similarity;
  }
  return best;
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
 * Both the UI and the enroll CLI drive enrollment through this one function, so
 * the orchestration is testable without a browser and without a microphone.
 *
 * @param {Array<Int16Array | number[]>} takes
 * @param {{ phrase: string, sampleRate: number }} meta
 * @returns {{ templates: { phrase: string, createdAt: string, features: number[], sampleRate: number }[], scores: number[] }}
 */
export function assembleTemplates(takes, { phrase, sampleRate }) {
  const templates = [];
  const scores = [];
  for (const take of takes) {
    const features = Array.from(extractFeatures(take, sampleRate));
    scores.push(scoreTake(features, templates));
    templates.push({ phrase, createdAt: new Date().toISOString(), features, sampleRate });
  }
  return { templates, scores };
}
