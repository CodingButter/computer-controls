/**
 * The proof-of-concept ear chain: enough ear to hold the seams open.
 *
 * The real tier-one ear — a local Moonshine transcriber — and the real Tier 0.5
 * wake-word detector — openWakeWord configured for "Mastra" — have not landed
 * yet. The proof of concept does not wait for them. What this file supplies is
 * the minimum that keeps every interface honest in the meantime.
 *
 * The VAD is real — a plain amplitude threshold, which is enough for the gate's
 * silence accounting. The wake word and the ear are deliberately deaf: the name
 * is never heard and nothing is transcribed, so the wake path CANNOT open the
 * gate. That is not a gap, it is the proof-of-concept's shape stated in code:
 * the only way this gate opens is the deliberate act of a person, and swapping
 * in a real wake word and ear later widens nothing silently.
 */
import { createWakeWordClassifier } from "./ear.js";
/**
 * Mean absolute amplitude above which a frame counts as speech. Int16 samples
 * run to 32767; a quiet room idles well under a few hundred.
 */
export const DEFAULT_SPEECH_THRESHOLD = 500;
/** Tier 0 as arithmetic: cheap enough to run on every frame, everywhere. */
export function createAmplitudeVad(threshold = DEFAULT_SPEECH_THRESHOLD) {
    return {
        isSpeech(frame) {
            if (frame.samples.length === 0)
                return false;
            let sum = 0;
            for (const sample of frame.samples)
                sum += Math.abs(sample);
            return sum / frame.samples.length >= threshold;
        },
        reset() { },
    };
}
/**
 * An ear that hears nothing, on purpose.
 *
 * An empty transcript is a closed gate — the gate discards untranscribable
 * utterances rather than opening on them — so this ear is the safest possible
 * placeholder: it can never turn ambient speech into network audio.
 */
export const deafEar = {
    languages: [],
    async transcribe() {
        return "";
    },
};
/**
 * A wake-word detector that never hears the name, on purpose.
 *
 * A false negative on the wake word costs a repeated sentence; a false positive
 * costs audio leaving the machine. So the safe placeholder never answers true:
 * speech never reaches the ear from here, which is the closed direction. The real
 * detector will run openWakeWord configured for "Mastra"; until it lands this
 * keeps the seam honest.
 */
export const deafWakeWord = {
    heard() {
        return false;
    },
    reset() { },
};
/**
 * A wake-word detector that always hears the name — the test double for orbs
 * that exercise the path past the wake tier. Production mounts the deaf word;
 * tests that need the gate to open on speech mount this one so the wake tier
 * stays transparent.
 */
export const alwaysWakeWord = {
    heard() {
        return true;
    },
    reset() { },
};
/** The chain the proof of concept mounts: real detector, deaf wake word, deaf ear. */
export function pocEarChain(threshold) {
    return {
        vad: createAmplitudeVad(threshold),
        wakeWord: deafWakeWord,
        ear: deafEar,
        classifier: createWakeWordClassifier(),
    };
}
