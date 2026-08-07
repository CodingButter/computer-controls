/**
 * How a recorded take becomes a template, and what score to show the person
 * making it.
 *
 * Enrolment happens on a page with buttons — the dashboard — but the arithmetic
 * cannot live there. The number under a take has to be the same number the gate
 * will compute later, or it is decoration: a green "97%" from one formula and a
 * gate that refuses on another is worse than showing nothing at all. So the
 * scoring lives beside the matcher and both the page and any offline tool call
 * into it.
 *
 * The module is pure: numbers in, numbers out, no filesystem, no network, no
 * audio API. It runs the same in a browser recording a voice, in a test with
 * neither microphone nor DOM, and in a script feeding it a WAV.
 */

import {
  DEFAULT_WAKE_THRESHOLD,
  ENROLLED_WAKE_WEIGHT,
  mfcc,
  subsequenceDtw,
} from "../live/fingerprint.ts";

/** The score shown for a take with nothing yet to compare against. */
export const NEUTRAL_SCORE = 0;

/**
 * The distance at which a take scores zero: twice the gate's threshold.
 *
 * It makes the number readable against the thing that actually matters. A take
 * the gate would accept scores at or above 0.5; anything under that is a take
 * the gate would refuse, and the person can hear themselves say it differently.
 */
export const SCORE_FLOOR_DISTANCE = DEFAULT_WAKE_THRESHOLD * 2;

/** How many takes an enrolment asks for. Three is enough to see a person drift. */
export const TARGET_TAKES = 3;

export type EnrolledTemplate = {
  id: string;
  phrase: string;
  createdAt: string;
  frames: number[][];
  sampleRate: number;
  weight: number;
};

/**
 * Raw samples to the frame sequence the matcher compares.
 *
 * Plain arrays rather than the typed arrays the matcher hands out, because
 * these end up as JSON: a Float32Array serialises to an object with numeric
 * keys, which reads back as a template nothing recognises.
 */
export function extractFeatures(samples: Int16Array | number[], sampleRate: number): number[][] {
  const data = samples instanceof Int16Array ? samples : Int16Array.from(samples);
  return mfcc(data, sampleRate).map((frame) => Array.from(frame));
}

/** A DTW distance as a score in [0, 1], calibrated against the gate's threshold. */
export function scoreFromDistance(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.max(0, Math.min(1, 1 - distance / SCORE_FLOOR_DISTANCE));
}

/**
 * Score one take against what is already enrolled, best match wins.
 *
 * Enrolment asks "does this sound like the ones I already have?", and the
 * closest answer is the answer.
 */
export function scoreTake(
  takeFrames: number[][],
  templates: readonly { frames: number[][] }[],
): number {
  if (templates.length === 0) return NEUTRAL_SCORE;
  if (takeFrames.length === 0) return 0;
  let best = Infinity;
  for (const template of templates) {
    if (!template.frames?.length) continue;
    const distance = subsequenceDtw(takeFrames, template.frames);
    if (distance < best) best = distance;
  }
  return scoreFromDistance(best);
}

/**
 * The whole orchestration: takes in, storable templates and per-take scores out.
 *
 * Each take is scored against the templates recorded *before* it, then appended
 * — first take against nothing, second against the first, third against both.
 * That is what a person watching actually wants to know: whether they are
 * saying it the same way twice.
 *
 * Every template carries ENROLLED_WAKE_WEIGHT, which is the matcher's constant,
 * not this module's: it divides the distance at match time so the voice that
 * lives with this machine clears the bar sooner than a stranger's. Writing it
 * onto the template means the gate reads where a template came from instead of
 * guessing.
 */
export function assembleTemplates(
  takes: readonly (Int16Array | number[])[],
  meta: { phrase: string; sampleRate: number },
): { templates: EnrolledTemplate[]; scores: number[] } {
  const templates: EnrolledTemplate[] = [];
  const scores: number[] = [];
  for (const take of takes) {
    const frames = extractFeatures(take, meta.sampleRate);
    scores.push(scoreTake(frames, templates));
    templates.push({
      id: `enrolled-${templates.length + 1}`,
      phrase: meta.phrase,
      createdAt: new Date().toISOString(),
      frames,
      sampleRate: meta.sampleRate,
      weight: ENROLLED_WAKE_WEIGHT,
    });
  }
  return { templates, scores };
}
