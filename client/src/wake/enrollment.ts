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

/**
 * How many takes an enrolment asks for.
 *
 * It was three, which is enough to see a person drift and was enough for the
 * synthesised voices the threshold was first measured against. It is not enough
 * for a person. The first live enrolment matched about one live utterance in
 * five, not because the takes were bad but because three of them describe one
 * way of saying the phrase — the careful one a person uses when a page has just
 * asked them to record something — and the phrase they actually say to the
 * machine later is the lazy one. Five takes cover more of a person than three
 * do, and the matcher keeps the closest, so a wider set costs nothing but the
 * twenty seconds spent making it.
 */
export const TARGET_TAKES = 5;

export type EnrolledTemplate = {
  id: string;
  phrase: string;
  createdAt: string;
  frames: number[][];
  sampleRate: number;
  weight: number;
};

/** Window the endpointer measures loudness over, and the step between windows. */
const ENERGY_WINDOW_MS = 20;

/**
 * How far above the quietest part of the recording a window has to be before it
 * counts as the person speaking, as a fraction of the range between the quietest
 * and the loudest.
 */
const SPEECH_FLOOR = 0.12;

/** Kept either side of the speech, so a soft first consonant is not clipped off. */
const EDGE_PADDING_MS = 120;

/**
 * Cut a recording down to the part of it that is a person talking.
 *
 * This is not tidiness. The matcher walks the whole template and requires the
 * stretch of live audio it matches to be about the same length, within a
 * quarter — that band is what stops it finding "hey mastra" inside a minute of
 * anything. A take recorded as a fixed window is the phrase plus however much
 * room tone the window had left over, and a template made from it can only ever
 * be matched by an utterance equally padded. Live utterances are not padded:
 * they are cut at the silence that ended them. So a 2.5 second template and a
 * 1.3 second phrase never meet, however well the phrase was said, and the gate
 * that looks broken is doing exactly what it was told.
 *
 * A recording with no discernible speech is returned whole. There is nothing to
 * trim to, and handing back an empty span would turn a bad take into no take.
 */
export function trimToSpeech(samples: Int16Array, sampleRate: number): Int16Array {
  const window = Math.max(1, Math.round((sampleRate * ENERGY_WINDOW_MS) / 1000));
  const energies: number[] = [];
  for (let start = 0; start + window <= samples.length; start += window) {
    let sum = 0;
    for (let i = start; i < start + window; i += 1) sum += samples[i] * samples[i];
    energies.push(Math.sqrt(sum / window));
  }
  if (energies.length === 0) return samples;

  const quietest = Math.min(...energies);
  const loudest = Math.max(...energies);
  const floor = quietest + (loudest - quietest) * SPEECH_FLOOR;
  const first = energies.findIndex((energy) => energy > floor);
  let last = -1;
  for (let i = energies.length - 1; i >= 0; i -= 1) {
    if (energies[i] > floor) {
      last = i;
      break;
    }
  }
  if (first < 0 || last < first) return samples;

  const padding = Math.round((sampleRate * EDGE_PADDING_MS) / 1000);
  const from = Math.max(0, first * window - padding);
  const to = Math.min(samples.length, (last + 1) * window + padding);
  return samples.subarray(from, to);
}

/**
 * Raw samples to the frame sequence the matcher compares.
 *
 * Plain arrays rather than the typed arrays the matcher hands out, because
 * these end up as JSON: a Float32Array serialises to an object with numeric
 * keys, which reads back as a template nothing recognises.
 */
export function extractFeatures(samples: Int16Array | number[], sampleRate: number): number[][] {
  const data = samples instanceof Int16Array ? samples : Int16Array.from(samples);
  return mfcc(trimToSpeech(data, sampleRate), sampleRate).map((frame) => Array.from(frame));
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
