/**
 * The detectors that are not the matcher.
 *
 * The VAD here is real and is what ships — a plain amplitude threshold, which
 * is enough for the gate's silence accounting and cheap enough to run on every
 * frame. The two wake-word detectors are ends of the range rather than
 * placeholders: one that never hears the phrase and one that always does.
 *
 * Both still earn their place now that a real matcher exists. A test proving
 * that idle audio stays home wants a detector that cannot open the gate, and a
 * test exercising everything downstream of the gate wants one that cannot keep
 * it shut. Neither test should have to synthesise a waveform that happens to
 * match a cepstral template in order to say what it means.
 */
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
 * A wake-word detector that never hears the phrase, on purpose.
 *
 * A false negative costs a repeated sentence; a false positive costs audio
 * leaving the machine. This is the closed direction, and it is what a detector
 * with no templates loaded degrades to — deaf rather than trigger-happy.
 */
export const deafWakeWord = {
    heard() {
        return false;
    },
    reset() { },
};
/**
 * A wake-word detector that always hears the phrase — the test double for
 * anything exercising the path past the wake tier. Nothing that ships mounts
 * it: a gate that always opens is not a gate.
 */
export const alwaysWakeWord = {
    heard() {
        return true;
    },
    reset() { },
};
/** A chain that can never open on its own: real detector, deaf wake word. */
export function pocEarChain(threshold) {
    return {
        vad: createAmplitudeVad(threshold),
        wakeWord: deafWakeWord,
    };
}
