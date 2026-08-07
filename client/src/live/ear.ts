/**
 * What the gate listens with, as interfaces.
 *
 * The gate in front of the realtime provider has to answer two questions before
 * any audio is allowed off this machine: is that speech, and was that the
 * phrase. Both answers come from things small enough to run on a CPU next to
 * everything else the hub is doing — a voice-activity detector around a
 * megabyte, and a matcher that is arithmetic over a few hundred numbers.
 *
 * There used to be a third question. A twenty-six megabyte transcriber turned
 * the utterance into text, and a classifier read the text to decide whether it
 * had been addressed to us. It is gone, and this file is most of what is left
 * of it. It failed in three separate ways, all of them structural rather than
 * unlucky: it crashed on inputs too short to be a word, it declined to answer
 * at all often enough that "a failed transcription is a closed gate" became a
 * documented behaviour, and it decided by spelling — which is how "hey mastra"
 * became "he mastered" and locked the owner out of his own machine.
 *
 * The phrase is a shape in the audio now, and nothing on this machine writes
 * down what was said in order to decide whether to listen to it.
 */

/** A chunk of mono 16-bit PCM as it arrives from the capture device. */
export type AudioFrame = {
  /** Raw samples. Never leaves the machine while the gate is closed. */
  samples: Int16Array;
  sampleRate: number;
};

/**
 * Tier 0. Decides whether a frame contains speech at all.
 *
 * This is the only thing that runs on every frame, which is why it has to be the
 * cheapest thing in the chain: most frames in a room are silence, and the whole
 * point of the tier is that silence never reaches the tier above it.
 */
export interface VoiceActivityDetector {
  /** True when this frame contains human speech. */
  isSpeech(frame: AudioFrame): boolean;
  /** Forget any cross-frame state. Called whenever the gate resets. */
  reset(): void;
}

/**
 * Tier 1. Decides whether a buffered utterance is the phrase.
 *
 * This is now the whole decision. It runs on completed utterances only, it is
 * synchronous because it is arithmetic rather than a model, and it answers no
 * by default: a detector holding no templates is deaf, never trigger-happy.
 */
export interface WakeWordDetector {
  /** True when the wake phrase is somewhere in this utterance. */
  heard(utterance: AudioFrame): boolean;
  /** Forget any cross-frame state. Called whenever the gate resets. */
  reset(): void;
}
