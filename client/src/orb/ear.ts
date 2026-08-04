/**
 * The cheap ear, and the seam it hides behind.
 *
 * The gate in front of the realtime provider has to answer two questions before
 * any audio is allowed off this machine: was that addressed to us, and what kind
 * of thing was it. Both answers come from models small enough to run on a CPU
 * next to everything else the hub is doing — a voice-activity detector around a
 * megabyte, and a transcriber around twenty-six.
 *
 * Which models those are is the part most likely to change. The issue names
 * Silero-class detection and Moonshine tiny English, and both are the right
 * choice today; neither is a choice this file should hard-code. Everything below
 * is an interface plus the one implementation detail that genuinely belongs to
 * the product rather than to a model: what counts as being addressed.
 *
 * The English-only constraint is not a technical limit — it is a licence. The
 * Moonshine English models are MIT; the multilingual ones ship under a
 * non-commercial community licence, which this product cannot use. The engine
 * behind `LocalEar` declares the languages it is actually allowed to hear so
 * that swapping the engine cannot silently widen what ships.
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
 * Tier 1. Turns a completed utterance into text, locally.
 *
 * `languages` is declared rather than assumed so the licence constraint is
 * visible at the seam: an engine that only holds MIT-licensed English weights
 * says `["en"]`, and an engine that claims more has to be a deliberate edit.
 */
export interface LocalEar {
  /** BCP-47 tags this ear is licensed and able to transcribe. */
  readonly languages: readonly string[];
  /** Transcribe a buffered utterance. Never performs network I/O. */
  transcribe(utterance: AudioFrame): Promise<string>;
}

/**
 * What kind of thing was said. The class picks the acknowledgement clip and
 * decides whether the request is worth the expensive brain, so it is a product
 * vocabulary rather than a model's.
 */
export type IntentClass = "question" | "command" | "small-talk" | "bare-wake";

/** The cheap ear's verdict on one utterance. */
export type Hearing = {
  /** Was this said to us, as opposed to near us. */
  addressed: boolean;
  intent: IntentClass;
  /** What the local ear heard. Stays local unless the gate opens. */
  transcript: string;
};

/**
 * Tier 1's second half: addressed-to-us and intent, in one pass.
 *
 * One pass rather than two because the two questions share all their evidence,
 * and because a second model is a second thing to keep small.
 */
export interface Classifier {
  classify(transcript: string): Hearing;
}

/**
 * The names this assistant answers to.
 *
 * A wake word is a blunt instrument and deliberately so: the gate's job is to be
 * wrong in the cheap direction. A false negative costs a repeated sentence; a
 * false positive costs audio leaving the machine, which is the one failure this
 * design exists to prevent.
 */
export const WAKE_WORDS: readonly string[] = ["computer", "hey computer", "orb"];

const COMMAND_VERBS = [
  "open",
  "close",
  "click",
  "type",
  "run",
  "find",
  "go to",
  "switch",
  "focus",
  "scroll",
  "copy",
  "paste",
  "save",
  "show me",
  "take",
  "make",
  "start",
  "stop",
];

const QUESTION_WORDS = ["what", "why", "how", "when", "where", "who", "which", "can you", "is it", "are there", "do i"];

/**
 * The default classifier: wake word plus shape of the sentence.
 *
 * This is not a model and does not pretend to be one. It is the honest floor —
 * the behaviour the gate has when nothing better has been installed — and it is
 * written out here rather than left as a stub because the gate's privacy
 * property has to hold with whatever classifier is present, including this one.
 * A learned classifier implements the same interface and replaces it whole.
 */
export function createWakeWordClassifier(
  wakeWords: readonly string[] = WAKE_WORDS,
): Classifier {
  const words = [...wakeWords].sort((a, b) => b.length - a.length);

  return {
    classify(transcript: string): Hearing {
      const text = transcript.trim().toLowerCase();
      const matched = words.find(
        (word) => text === word || text.startsWith(`${word} `) || text.startsWith(`${word}, `),
      );

      if (!matched) {
        return { addressed: false, intent: "small-talk", transcript };
      }

      const remainder = text.slice(matched.length).replace(/^[\s,.!?]+/, "");
      if (!remainder) {
        return { addressed: true, intent: "bare-wake", transcript };
      }
      if (COMMAND_VERBS.some((verb) => remainder.startsWith(verb))) {
        return { addressed: true, intent: "command", transcript };
      }
      if (remainder.endsWith("?") || QUESTION_WORDS.some((word) => remainder.startsWith(word))) {
        return { addressed: true, intent: "question", transcript };
      }
      return { addressed: true, intent: "small-talk", transcript };
    },
  };
}

/**
 * Whether an intent is worth waking the expensive brain for.
 *
 * Small talk and a bare wake word are answered by the realtime provider's own
 * fluency — that is the entire division of labour the issue draws. Questions and
 * commands are actionable, and actionable means one function call into the hub's
 * agent, where the model pack and the consent ceiling live.
 */
export function isActionable(intent: IntentClass): boolean {
  return intent === "question" || intent === "command";
}
