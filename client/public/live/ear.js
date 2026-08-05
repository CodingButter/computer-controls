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
/** The resting label, and what anything unrecognised falls back to. */
export const DEFAULT_SENTIMENT = "neutral";
export const SENTIMENTS = [
    "frustrated",
    "excited",
    "calm",
    "neutral",
];
/**
 * The names this assistant answers to.
 *
 * A wake word is a blunt instrument and deliberately so: the gate's job is to be
 * wrong in the cheap direction. A false negative costs a repeated sentence; a
 * false positive costs audio leaving the machine, which is the one failure this
 * design exists to prevent.
 */
export const WAKE_WORDS = ["mastra", "hey mastra"];
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
 * The words that tint the orb, and the honest floor for reading them.
 *
 * Like the classifier around it, this is not a model. It is a small list of
 * things people say when a machine has just wasted their time, and a smaller
 * one for when something worked. Both are checked against the same transcript
 * the intent pass already has in hand.
 *
 * Frustration is listed first and checked first on purpose. When somebody is
 * both excited and annoyed, the annoyed reading is the one worth showing: an
 * orb that glows cheerfully at a person who is losing patience is worse than an
 * orb that stays grey.
 */
const FRUSTRATION_MARKERS = [
    "again",
    "still not",
    "still doesn't",
    "still didn't",
    "doesn't work",
    "does not work",
    "didn't work",
    "not working",
    "broken",
    "wrong",
    "no no",
    "stop",
    "why won't",
    "why doesn't",
    "come on",
    "for the love",
    "seriously",
    "ugh",
    "damn",
];
const EXCITEMENT_MARKERS = [
    "amazing",
    "awesome",
    "brilliant",
    "beautiful",
    "perfect",
    "excellent",
    "fantastic",
    "wonderful",
    "love it",
    "nice one",
    "yes!",
    "that worked",
    "it worked",
    "thank you so much",
];
const CALM_MARKERS = [
    "no rush",
    "whenever",
    "take your time",
    "just wondering",
    "curious",
    "by the way",
    "if you don't mind",
    "please",
    "thanks",
    "thank you",
];
/**
 * Read the tone of one utterance from the text the ear already produced.
 *
 * Exported so the mapping is testable on its own and so the seam is obvious:
 * a real classifier replaces this function's body, or the whole `Classifier`,
 * without anything downstream changing. What must not change is the shape —
 * one label out of four, derived locally, from a transcript.
 */
export function readSentiment(transcript) {
    const text = transcript.trim().toLowerCase();
    if (!text)
        return DEFAULT_SENTIMENT;
    // Repeated punctuation is the one piece of prosody that survives a
    // transcript, so it is worth reading: "it's broken!!" is not "it's broken".
    const emphatic = /[!?]{2,}/.test(text);
    if (FRUSTRATION_MARKERS.some((marker) => text.includes(marker)))
        return "frustrated";
    if (EXCITEMENT_MARKERS.some((marker) => text.includes(marker)))
        return "excited";
    // Emphasis with no other signal reads as excitement rather than frustration.
    // Being wrong in the generous direction costs a warm colour; being wrong the
    // other way tells somebody having a fine day that they sound angry.
    if (emphatic)
        return "excited";
    if (CALM_MARKERS.some((marker) => text.includes(marker)))
        return "calm";
    return DEFAULT_SENTIMENT;
}
/**
 * The default classifier: wake word plus shape of the sentence.
 *
 * This is not a model and does not pretend to be one. It is the honest floor —
 * the behaviour the gate has when nothing better has been installed — and it is
 * written out here rather than left as a stub because the gate's privacy
 * property has to hold with whatever classifier is present, including this one.
 * A learned classifier implements the same interface and replaces it whole.
 */
export function createWakeWordClassifier(wakeWords = WAKE_WORDS) {
    const words = [...wakeWords].sort((a, b) => b.length - a.length);
    return {
        classify(transcript) {
            const text = transcript.trim().toLowerCase();
            const matched = words.find((word) => text === word || text.startsWith(`${word} `) || text.startsWith(`${word}, `));
            if (!matched) {
                // Not addressed to us, so nothing is read from it. Sentiment is only
                // ever inferred about somebody who chose to talk to this machine —
                // reading the mood of a conversation happening near it is not a thing
                // this product does, and returning the resting label rather than a
                // guess is what makes that true rather than merely intended.
                return { addressed: false, intent: "small-talk", transcript, sentiment: DEFAULT_SENTIMENT };
            }
            // The wake word is not part of how somebody sounds, so the tone is read
            // from what they actually said after it.
            const remainder = text.slice(matched.length).replace(/^[\s,.!?]+/, "");
            const sentiment = readSentiment(remainder);
            if (!remainder) {
                return { addressed: true, intent: "bare-wake", transcript, sentiment };
            }
            if (COMMAND_VERBS.some((verb) => remainder.startsWith(verb))) {
                return { addressed: true, intent: "command", transcript, sentiment };
            }
            if (remainder.endsWith("?") || QUESTION_WORDS.some((word) => remainder.startsWith(word))) {
                return { addressed: true, intent: "question", transcript, sentiment };
            }
            return { addressed: true, intent: "small-talk", transcript, sentiment };
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
export function isActionable(intent) {
    return intent === "question" || intent === "command";
}
