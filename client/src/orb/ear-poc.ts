/**
 * The proof-of-concept ear chain: enough ear to hold the seams open.
 *
 * The real tier-one ear — a local Moonshine transcriber — has not landed yet.
 * The proof of concept does not wait for it, because Jamie's ruling changed the
 * consent gesture: visiting the orb page IS the permission to listen, so the
 * gate is opened by the visit rather than by a wake phrase, and while the gate
 * is open the ear is never consulted. What this file supplies is the minimum
 * that keeps every interface honest in the meantime.
 *
 * The detector is real — a plain amplitude threshold, which is enough for the
 * gate's silence accounting. The ear is deliberately deaf: it transcribes
 * nothing, so the wake-word path CANNOT open the gate. That is not a gap, it is
 * the proof-of-concept's shape stated in code: the only way this gate opens is
 * the deliberate act of a person, and swapping in a real ear later widens
 * nothing silently.
 */

import type { AudioFrame, Classifier, LocalEar, VoiceActivityDetector } from "./ear.ts";
import { createWakeWordClassifier } from "./ear.ts";

/**
 * Mean absolute amplitude above which a frame counts as speech. Int16 samples
 * run to 32767; a quiet room idles well under a few hundred.
 */
export const DEFAULT_SPEECH_THRESHOLD = 500;

/** Tier 0 as arithmetic: cheap enough to run on every frame, everywhere. */
export function createAmplitudeVad(
  threshold: number = DEFAULT_SPEECH_THRESHOLD,
): VoiceActivityDetector {
  return {
    isSpeech(frame: AudioFrame): boolean {
      if (frame.samples.length === 0) return false;
      let sum = 0;
      for (const sample of frame.samples) sum += Math.abs(sample);
      return sum / frame.samples.length >= threshold;
    },
    reset() {},
  };
}

/**
 * An ear that hears nothing, on purpose.
 *
 * An empty transcript is a closed gate — the gate discards untranscribable
 * utterances rather than opening on them — so this ear is the safest possible
 * placeholder: it can never turn ambient speech into network audio.
 */
export const deafEar: LocalEar = {
  languages: [],
  async transcribe(): Promise<string> {
    return "";
  },
};

export type PocEarChain = {
  vad: VoiceActivityDetector;
  ear: LocalEar;
  classifier: Classifier;
};

/** The chain the proof of concept mounts: real detector, deaf ear. */
export function pocEarChain(threshold?: number): PocEarChain {
  return {
    vad: createAmplitudeVad(threshold),
    ear: deafEar,
    classifier: createWakeWordClassifier(),
  };
}
