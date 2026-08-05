/**
 * The wake gate: the one place audio is allowed off this machine.
 *
 * The property this file exists to hold is narrow and testable. While the gate
 * is closed, microphone audio reaches the voice detector and the local ear and
 * stops there — no frame is handed to the realtime provider, and the provider's
 * socket, though open, is muted. Audio is forwarded only after the cheap ear has
 * said both that it was speech and that it was addressed to us.
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

import type {
  AudioFrame,
  Classifier,
  Hearing,
  LocalEar,
  VoiceActivityDetector,
  WakeWordDetector,
} from "./ear.ts";
import { DEFAULT_SENTIMENT } from "./ear.ts";

/**
 * Where the gate is.
 *
 * `idle` is the resting state and the private one. `hearing` means the detector
 * found speech and frames are accumulating locally for the ear. `open` means the
 * ear said yes and audio is being forwarded. There is no state in which audio
 * forwards without having passed through the two below it.
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

export type GateEvents = {
  /** The gate opened; audio may now be forwarded. Carries what was heard. */
  onOpen(hearing: Hearing): void;
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
  ear: LocalEar;
  classifier: Classifier;
  events: GateEvents;
  quietPeriodMs?: number;
  utteranceSilenceMs?: number;
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
  #silenceMs = 0;
  #openedSilenceMs = 0;
  /** Serialises the ear so two utterances can never be transcribed at once. */
  #hearing: Promise<void> = Promise.resolve();

  readonly #vad: VoiceActivityDetector;
  readonly #wakeWord: WakeWordDetector;
  readonly #ear: LocalEar;
  readonly #classifier: Classifier;
  readonly #events: GateEvents;
  readonly #quietPeriodMs: number;
  readonly #utteranceSilenceMs: number;

  constructor(deps: GateDeps) {
    this.#vad = deps.vad;
    this.#wakeWord = deps.wakeWord;
    this.#ear = deps.ear;
    this.#classifier = deps.classifier;
    this.#events = deps.events;
    this.#quietPeriodMs = deps.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
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
      this.#openedSilenceMs = speech ? 0 : this.#openedSilenceMs + durationMs;
      if (this.#openedSilenceMs >= this.#quietPeriodMs) this.close();
      return this.#hearing;
    }

    if (speech) {
      this.#state = "hearing";
      this.#buffer.push(frame);
      this.#bufferedMs += durationMs;
      this.#silenceMs = 0;
      if (this.#bufferedMs >= MAX_UTTERANCE_MS) this.#discard();
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
  async #consider(utterance: AudioFrame): Promise<void> {
    if (!this.#wakeWord.heard(utterance)) return;

    let transcript: string;
    try {
      transcript = await this.#ear.transcribe(utterance);
    } catch {
      return;
    }
    if (!transcript.trim()) return;

    const hearing = this.#classifier.classify(transcript);
    if (!hearing.addressed) return;

    this.#state = "open";
    this.#openedSilenceMs = 0;
    this.#events.onOpen(hearing);
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

  #discard(): void {
    this.#resetBuffer();
    this.#state = "idle";
    this.#vad.reset();
    this.#wakeWord.reset();
  }

  #resetBuffer(): void {
    this.#buffer = [];
    this.#bufferedMs = 0;
    this.#silenceMs = 0;
  }

  /** The languages the installed ear may hear, surfaced for health and the UI. */
  get languages(): readonly string[] {
    return this.#ear.languages;
  }
}
