/**
 * The wake gate: the one place audio is allowed off this machine.
 *
 * The property this file exists to hold is narrow and testable. While the gate
 * is closed, microphone audio reaches the voice detector and the local ear and
 * stops there — no frame is handed to the realtime provider, and the provider's
 * socket, though open, is muted. Audio is forwarded only after the cheap ear has
 * said both that it was speech and that it was addressed to us.
 *
 * Issue #107 moves this chain into the hub process, at the OS audio layer,
 * rather than into a browser page. That placement is what makes the property
 * enforceable at all: a page can be closed, reloaded, or opened twice, and a
 * privacy guarantee that depends on which faces happen to be alive is not a
 * guarantee. The hub owns the microphone; every face is a renderer.
 *
 * The gate is deliberately not the expensive model. It never calls the brain, it
 * never calls the realtime provider, and the only thing it emits when it decides
 * against opening is nothing at all.
 */
import { DEFAULT_SENTIMENT } from "./ear.js";
/** How long the gate stays open with nothing said before it drops back to idle. */
export const DEFAULT_QUIET_PERIOD_MS = 8_000;
/**
 * How long a silence has to run before a buffered utterance is considered
 * finished and handed to the ear. Short enough not to feel like latency, long
 * enough to survive the pause in the middle of a sentence.
 */
export const DEFAULT_UTTERANCE_SILENCE_MS = 600;
/**
 * An upper bound on what the gate will buffer before giving up on an utterance.
 *
 * Without it, a room with a television in it accumulates frames forever. The
 * buffer is dropped rather than transcribed, because a thirty-second monologue
 * that nobody addressed to us is exactly the thing the gate is for.
 */
export const MAX_UTTERANCE_MS = 15_000;
function frameDurationMs(frame) {
    return (frame.samples.length / frame.sampleRate) * 1000;
}
function concatFrames(frames) {
    const sampleRate = frames[0]?.sampleRate ?? 16_000;
    const total = frames.reduce((sum, frame) => sum + frame.samples.length, 0);
    const samples = new Int16Array(total);
    let offset = 0;
    for (const frame of frames) {
        samples.set(frame.samples, offset);
        offset += frame.samples.length;
    }
    return { samples, sampleRate };
}
/**
 * The gate as a state machine over frames.
 *
 * Every frame goes through `push`, and `push` is the only entry point, so there
 * is exactly one path from the microphone to the network and it is the path
 * below. A caller cannot forward a frame by holding the gate differently.
 */
export class WakeGate {
    #state = "idle";
    #buffer = [];
    #bufferedMs = 0;
    #silenceMs = 0;
    #openedSilenceMs = 0;
    /** Serialises the ear so two utterances can never be transcribed at once. */
    #hearing = Promise.resolve();
    #vad;
    #wakeWord;
    #ear;
    #classifier;
    #events;
    #quietPeriodMs;
    #utteranceSilenceMs;
    constructor(deps) {
        this.#vad = deps.vad;
        this.#wakeWord = deps.wakeWord;
        this.#ear = deps.ear;
        this.#classifier = deps.classifier;
        this.#events = deps.events;
        this.#quietPeriodMs = deps.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
        this.#utteranceSilenceMs = deps.utteranceSilenceMs ?? DEFAULT_UTTERANCE_SILENCE_MS;
    }
    get state() {
        return this.#state;
    }
    /** True exactly when audio is permitted to leave the machine. */
    get isOpen() {
        return this.#state === "open";
    }
    /**
     * Feed one frame in.
     *
     * Returns a promise that settles once any transcription this frame triggered
     * has finished, so a test can await the gate rather than poll it.
     */
    push(frame) {
        const speech = this.#vad.isSpeech(frame);
        const durationMs = frameDurationMs(frame);
        if (this.#state === "open") {
            // Forwarding is the only thing that happens here. The gate has already
            // decided; re-deciding on every frame would cut a person off mid-sentence.
            this.#events.onForward(frame);
            this.#openedSilenceMs = speech ? 0 : this.#openedSilenceMs + durationMs;
            if (this.#openedSilenceMs >= this.#quietPeriodMs)
                this.close();
            return this.#hearing;
        }
        if (speech) {
            this.#state = "hearing";
            this.#buffer.push(frame);
            this.#bufferedMs += durationMs;
            this.#silenceMs = 0;
            if (this.#bufferedMs >= MAX_UTTERANCE_MS)
                this.#discard();
            return this.#hearing;
        }
        if (this.#state === "hearing") {
            this.#silenceMs += durationMs;
            if (this.#silenceMs >= this.#utteranceSilenceMs) {
                const utterance = concatFrames(this.#buffer);
                this.#resetBuffer();
                this.#state = "idle";
                this.#hearing = this.#hearing.then(() => this.#consider(utterance));
            }
        }
        return this.#hearing;
    }
    /**
     * Ask the wake word and the cheap ear about a buffered utterance, and open only
     * on a yes from both.
     *
     * The wake word is checked first because it is cheaper than the ear: speech
     * without the name never reaches transcription. A transcription failure is a
     * closed gate. The alternative — opening when the ear could not answer — would
     * turn every crash in a small local model into audio on the network, which
     * inverts the point of having the model.
     */
    async #consider(utterance) {
        if (!this.#wakeWord.heard(utterance))
            return;
        let transcript;
        try {
            transcript = await this.#ear.transcribe(utterance);
        }
        catch {
            return;
        }
        if (!transcript.trim())
            return;
        const hearing = this.#classifier.classify(transcript);
        if (!hearing.addressed)
            return;
        this.#state = "open";
        this.#openedSilenceMs = 0;
        this.#events.onOpen(hearing);
    }
    /** Drop the gate back to idle. The human tapping the orb lands here too. */
    close() {
        if (this.#state === "idle")
            return;
        this.#state = "idle";
        this.#resetBuffer();
        this.#vad.reset();
        this.#wakeWord.reset();
        this.#events.onIdle();
    }
    /**
     * Open the gate without the ear's say-so, because a person asked directly.
     *
     * Tapping the orb is a deliberate act by someone standing at the machine, and
     * it is not a hole in the property: the property is that *idle* audio never
     * leaves, and a human toggling the gate is the definition of not idle.
     */
    openByHand() {
        this.#resetBuffer();
        this.#openedSilenceMs = 0;
        this.#state = "open";
        this.#events.onOpen({
            addressed: true,
            intent: "bare-wake",
            transcript: "",
            // A tap is a gesture, not an utterance. There is nothing to read a mood
            // from, and inventing one from the act of reaching for the orb would be
            // a guess about a person built out of nothing they said.
            sentiment: DEFAULT_SENTIMENT,
        });
    }
    #discard() {
        this.#resetBuffer();
        this.#state = "idle";
        this.#vad.reset();
        this.#wakeWord.reset();
    }
    #resetBuffer() {
        this.#buffer = [];
        this.#bufferedMs = 0;
        this.#silenceMs = 0;
    }
    /** The languages the installed ear may hear, surfaced for health and the UI. */
    get languages() {
        return this.#ear.languages;
    }
}
