/**
 * The wake gate: the one place audio is allowed off this machine.
 *
 * The property this file exists to hold is narrow and testable. While the gate
 * is closed, microphone audio reaches the voice detector and the wake word
 * detector and stops there — no frame is handed to the realtime provider, and
 * the provider's socket, though open, is muted. Audio is forwarded only after
 * something local has said both that it was speech and that it was the phrase.
 *
 * What decides used to be a transcript. It is a shape now. The gate asks the
 * fingerprint whether the waveform looks like the phrase, and nothing on this
 * machine ever writes down what was said in order to decide whether to listen
 * to it — which is a stronger version of the same promise, and the reason a
 * Swedish spelling of "hey" can no longer keep somebody locked out of their
 * own computer.
 *
 * This chain runs wherever the microphone lives. It was written for the hub
 * process (#107); the client migration moved the microphones to the devices,
 * and the gate moved with them — the widget's ears and any future client run
 * this same file against the mic they own. The property is unchanged wherever
 * it runs: the machine holding the microphone decides, locally, whether a
 * frame ever leaves it.
 *
 * The gate is deliberately not the expensive model. It never calls the brain, it
 * never calls the realtime provider, and the only thing it emits when it decides
 * against opening is nothing at all.
 */

import type { AudioFrame, VoiceActivityDetector, WakeWordDetector } from "./ear.ts";

/**
 * What the gate says when it opens.
 *
 * The utterance that opened it rides along, because it is usually not just the
 * phrase: a person says "hey mastra, what's the weather" in one breath, and the
 * audio carrying the question is the same audio that carried the name. Handing
 * it to the caller is what lets the question be answered rather than asked for
 * again. A tap on the orb carries nothing — there was no utterance, and
 * inventing one would be a guess about a person built out of a gesture.
 */
export type Waking = {
  /** The audio that opened the gate, or null when a person opened it by hand. */
  utterance: AudioFrame | null;
};

/**
 * Where the gate is.
 *
 * `idle` is the resting state and the private one. `hearing` means the detector
 * found speech and frames are accumulating locally for the wake word. `open`
 * means the wake word said yes and audio is being forwarded. There is no state
 * in which audio forwards without having passed through the two below it.
 */
export type GateState = "idle" | "hearing" | "open";

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

/**
 * The least actual speech an utterance needs before it is worth matching.
 *
 * Shorter than the shortest word anyone wakes a machine with. An amplitude
 * detector opens on a chair creak or a keyboard click, and the buffer that
 * follows is one loud frame plus the silence that closed it — too short to
 * carry the phrase, and cheaper to reject here than to run through a cepstral
 * transform first. Measured against speech frames only, not buffer length: the
 * interior pauses an utterance legitimately carries do not count toward being
 * a word.
 */
export const MIN_SPEECH_MS = 150;

export type GateEvents = {
  /** The gate opened; audio may now be forwarded. Carries what opened it. */
  onOpen(waking: Waking): void;
  /** The gate dropped back to idle after the quiet period. */
  onIdle(): void;
  /**
   * A frame cleared for forwarding to the realtime provider.
   *
   * Called only while the gate is open. Everything upstream of this callback is
   * local; everything downstream is the network. That is the whole boundary.
   */
  onForward(frame: AudioFrame): void;
};

export type GateDeps = {
  vad: VoiceActivityDetector;
  wakeWord: WakeWordDetector;
  events: GateEvents;
  quietPeriodMs?: number;
  utteranceSilenceMs?: number;
  /**
   * The quiet period does not run while this answers true.
   *
   * A conversation is not over because one side of it is quiet: while the
   * mouth is playing the model's answer, the user is listening, and eight
   * seconds of listening is not abandonment. Live QA watched the alternative —
   * a long answer cut off mid-sentence because the person receiving it had
   * the manners not to talk over it.
   */
  hold?: () => boolean;
  /** Injected so tests drive time rather than wait for it. */
  now?: () => number;
};

function frameDurationMs(frame: AudioFrame): number {
  return (frame.samples.length / frame.sampleRate) * 1000;
}

function concatFrames(frames: AudioFrame[]): AudioFrame {
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
  #state: GateState = "idle";
  #buffer: AudioFrame[] = [];
  #bufferedMs = 0;
  #speechMs = 0;
  #silenceMs = 0;
  #openedSilenceMs = 0;
  /** Serialises the ear so two utterances can never be transcribed at once. */
  #hearing: Promise<void> = Promise.resolve();

  readonly #vad: VoiceActivityDetector;
  readonly #wakeWord: WakeWordDetector;
  readonly #events: GateEvents;
  readonly #quietPeriodMs: number;
  readonly #hold: () => boolean;
  readonly #utteranceSilenceMs: number;

  constructor(deps: GateDeps) {
    this.#vad = deps.vad;
    this.#wakeWord = deps.wakeWord;
    this.#events = deps.events;
    this.#quietPeriodMs = deps.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
    this.#hold = deps.hold ?? (() => false);
    this.#utteranceSilenceMs = deps.utteranceSilenceMs ?? DEFAULT_UTTERANCE_SILENCE_MS;
  }

  get state(): GateState {
    return this.#state;
  }

  /** True exactly when audio is permitted to leave the machine. */
  get isOpen(): boolean {
    return this.#state === "open";
  }

  /**
   * Feed one frame in.
   *
   * Returns a promise that settles once any transcription this frame triggered
   * has finished, so a test can await the gate rather than poll it.
   */
  push(frame: AudioFrame): Promise<void> {
    const speech = this.#vad.isSpeech(frame);
    const durationMs = frameDurationMs(frame);

    if (this.#state === "open") {
      // Forwarding is the only thing that happens here. The gate has already
      // decided; re-deciding on every frame would cut a person off mid-sentence.
      this.#events.onForward(frame);
      // The quiet clock does not run while the gate is held: the mouth is
      // playing the model's answer and the user is listening, not gone. It
      // starts from zero when the hold lifts, so the quiet period after an
      // answer ends is always a full one.
      this.#openedSilenceMs = speech || this.#hold() ? 0 : this.#openedSilenceMs + durationMs;
      if (this.#openedSilenceMs >= this.#quietPeriodMs) this.close();
      return this.#hearing;
    }

    if (speech) {
      this.#state = "hearing";
      this.#buffer.push(frame);
      this.#bufferedMs += durationMs;
      this.#speechMs += durationMs;
      this.#silenceMs = 0;
      if (this.#bufferedMs >= MAX_UTTERANCE_MS) this.#discard();
      return this.#hearing;
    }

    if (this.#state === "hearing") {
      // A pause is part of the utterance until it is long enough to end it.
      // Buffering only the frames the detector called speech would hand the
      // ear the loud parts of a word concatenated with the gaps cut out —
      // time-compressed audio no speech model was trained on. Live QA watched
      // exactly that: "Mastra" transcribing as "A" because the pauses between
      // syllables had been removed from the waveform.
      this.#buffer.push(frame);
      this.#bufferedMs += durationMs;
      this.#silenceMs += durationMs;
      if (this.#bufferedMs >= MAX_UTTERANCE_MS) {
        this.#discard();
        return this.#hearing;
      }
      if (this.#silenceMs >= this.#utteranceSilenceMs) {
        const utterance = concatFrames(this.#buffer);
        const speechMs = this.#speechMs;
        this.#resetBuffer();
        this.#state = "idle";
        // A blip is not a word. An utterance whose actual speech content is
        // shorter than the shortest word is never matched — below this floor
        // the buffer is mostly the silence that closed it, and there is no
        // phrase in it to find.
        if (speechMs < MIN_SPEECH_MS) return this.#hearing;
        this.#hearing = this.#hearing.then(() => this.#consider(utterance));
      }
    }
    return this.#hearing;
  }

  /**
   * Ask the wake word about a buffered utterance, and open only on a yes.
   *
   * This used to be two questions: does the waveform look like the phrase, and
   * then, does a transcript of it read as addressed to us. The second one is
   * gone. It cost a 26MB model that crashed on short inputs, it turned every
   * failure of that model into a closed gate, and it decided by spelling —
   * which is how "hey mastra" became "he mastered" and locked out the person
   * who owns the machine. The shape answers the only question the gate ever
   * needed answered, and it answers it without writing anything down.
   *
   * Still async: it is called from a serialised chain so two utterances can
   * never be considered at once, and a future matcher that runs somewhere
   * other than this thread should not have to change this file's shape.
   */
  async #consider(utterance: AudioFrame): Promise<void> {
    if (!this.#wakeWord.heard(utterance)) return;

    this.#state = "open";
    this.#openedSilenceMs = 0;
    // The utterance goes out as the opening audio rather than as a transcript
    // of itself. Nothing read it; it is simply the first thing the provider
    // hears, which is also what the person intended it to be.
    this.#events.onOpen({ utterance });
  }

  /** Drop the gate back to idle. The human tapping the orb lands here too. */
  close(): void {
    if (this.#state === "idle") return;
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
  openByHand(): void {
    this.#resetBuffer();
    this.#openedSilenceMs = 0;
    this.#state = "open";
    // A tap is a gesture, not an utterance: there is nothing to send ahead of
    // what the person is about to say.
    this.#events.onOpen({ utterance: null });
  }

  #discard(): void {
    this.#resetBuffer();
    this.#state = "idle";
    this.#vad.reset();
    this.#wakeWord.reset();
  }

  #resetBuffer(): void {
    this.#buffer = [];
    this.#bufferedMs = 0;
    this.#speechMs = 0;
    this.#silenceMs = 0;
  }

}
