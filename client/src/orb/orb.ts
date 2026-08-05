/**
 * The orb, assembled.
 *
 * Everything the lane owns meets here: the hub-side wake gate, the realtime
 * session that is only a mouth and a pair of ears, the utterance bank that hides
 * the first second of latency, the single-file mouth, and the one function call
 * that reaches the actual brain.
 *
 * `#onFunctionCall` no longer waits for the brain. An acknowledgment result is
 * returned immediately so the provider keeps its voice — the hub turn runs in
 * the background and its answer is injected as a spoken text signal when it
 * resolves. Filler covers the first beat; progress signals carry the rest; the
 * answer speaks last. The provider is never left in dead air.
 *
 * If the socket drops while a dispatch is in flight, the answer is queued and
 * spoken on reconnect — never silently swallowed. The one-mouth rule still
 * holds: the Mouth is a queue, so injected answers line up behind whatever is
 * already being said.
 */

import type { Hearing, Sentiment } from "./ear.ts";
import { isActionable } from "./ear.ts";
import { WakeGate, type GateDeps, type GateState } from "./gate.ts";
import type { FunctionCall, RealtimeSession } from "./live.ts";
import { Mouth, type Utterance } from "./mouth.ts";
import type { Clip, UtteranceBank } from "./utterance-bank.ts";

/** How the orb reaches the hub's agent: one call, text in, text out. */
export interface HubBrain {
  ask(request: string, onProgress?: (signal: string) => void): Promise<string>;
}

/** Plays bytes on the machine's speaker. */
export interface Speaker {
  play(audio: Uint8Array, signal: AbortSignal): Promise<void>;
}

/**
 * The immediate result returned for a dispatch, so the provider keeps its voice
 * while the hub works. First-person and ownership-framed: the provider is told
 * it is handling this itself, never that something was dispatched elsewhere.
 */
const DISPATCH_ACK =
  "Acknowledged. You are handling this yourself now — keep the user company " +
  "while you work. The result arrives as a separate message; relay it in your " +
  "own words, taking ownership. Never mention dispatching, agents, or the hub.";

/** Frames an injected answer so the provider relays it rather than reading it as a new request. */
const ANSWER_PREFIX =
  'The result of your request is in. Tell the user, in your own words and taking full ownership: "';
const ANSWER_SUFFIX = '"';

/** Frames a progress signal so the provider narrates it in first person. */
const PROGRESS_PREFIX =
  'Progress update. Tell the user, in your own words and taking ownership: "';
const PROGRESS_SUFFIX = '"';

/**
 * What the faces watching this orb are told.
 *
 * `mood` is the one word here that is not a fact about the machine — it is a
 * guess about a person (#106). It is emitted and forgotten in the same breath:
 * the orb keeps no mood field, `status` does not report one, and a face that
 * connects mid-conversation is told the state but not the mood, because there
 * is nowhere to have kept it. That is what "it lives as long as the pixels"
 * means when written as code rather than as a promise.
 */
export type OrbEvent =
  | { type: "state"; state: OrbState }
  | { type: "caption"; text: string; speaker: "user" | "assistant" }
  | { type: "mood"; mood: Sentiment };

/**
 * The four things the orb can be doing, which are also the four ways it moves.
 *
 * The page renders state as motion rather than as a label, so this union is the
 * animation vocabulary as much as it is the runtime one.
 */
export type OrbState = "idle" | "listening" | "thinking" | "speaking";

export type OrbDeps = {
  gate: Omit<GateDeps, "events">;
  session: RealtimeSession;
  bank: UtteranceBank;
  mouth: Mouth;
  speaker: Speaker;
  brain: HubBrain;
  onEvent?(event: OrbEvent): void;
};

function clipUtterance(clip: Clip, speaker: Speaker): Utterance {
  return {
    id: clip.id,
    kind: "filler",
    play: (signal) => speaker.play(clip.audio, signal),
  };
}

export class Orb {
  readonly #gate: WakeGate;
  readonly #session: RealtimeSession;
  readonly #bank: UtteranceBank;
  readonly #mouth: Mouth;
  readonly #speaker: Speaker;
  readonly #brain: HubBrain;
  readonly #onEvent: (event: OrbEvent) => void;
  #state: OrbState = "idle";
  /** Monotonic dispatch counter; ids are orb-owned, not the socket-scoped call.id. */
  #dispatchSeq = 0;
  /** In-flight dispatches, keyed by orb-generated id so answers are attributable. */
  #pending = new Map<number, string>();
  /** Text turns queued while the socket was down, flushed on reconnect. */
  #pendingAnnouncements: string[] = [];
  #closed = false;

  constructor(deps: OrbDeps) {
    this.#session = deps.session;
    this.#bank = deps.bank;
    this.#mouth = deps.mouth;
    this.#speaker = deps.speaker;
    this.#brain = deps.brain;
    this.#onEvent = deps.onEvent ?? (() => {});

    this.#gate = new WakeGate({
      ...deps.gate,
      events: {
        onOpen: (hearing) => this.#onWake(hearing),
        onIdle: () => this.#onQuiet(),
        // The single line where local audio becomes network audio. The mute
        // check is belt and braces: the gate should never forward while muted,
        // and if it ever did, the session still would not transmit.
        onForward: (frame) => {
          if (this.#session.muted) return;
          this.#session.sendAudio(new Uint8Array(frame.samples.buffer.slice(0)));
        },
      },
    });

    // Idle is muted. The socket stays open — reconnecting at the moment somebody
    // is waiting to be heard is the latency this design refuses to pay — but
    // nothing is written to it until the cheap ear says so.
    this.#session.mute();
  }

  get state(): OrbState {
    return this.#state;
  }

  get gateState(): GateState {
    return this.#gate.state;
  }

  /** Every captured frame enters here, and only here. */
  push(frame: Parameters<WakeGate["push"]>[0]): Promise<void> {
    return this.#gate.push(frame);
  }

  /** The human tapped the orb. Toggles the gate by hand. */
  toggle(): void {
    if (this.#gate.isOpen) {
      this.#gate.close();
      return;
    }
    this.#gate.openByHand();
  }

  /**
   * Drop the gate, whatever it was doing. Muting and dismissing both land here.
   *
   * Unconditional rather than a toggle, because the two gestures that reach it
   * mean "stop listening" and a gesture that sometimes started listening instead
   * would be the worst possible reading of a mute button.
   */
  closeGate(): void {
    this.#gate.close();
  }

  /** The languages the installed ear is licensed to hear. */
  get languages(): readonly string[] {
    return this.#gate.languages;
  }

  /**
   * A signal, arriving as text, spoken unprompted.
   *
   * The hub owns the session, so a qualifying signal is pushed straight in as a
   * text turn. That is the whole mechanism — and it is deliberately behind this
   * one method, because the plugin-side `signalProviders` surface that would
   * otherwise carry it is not in the released SDK yet. When it lands, it calls
   * this; nothing else moves.
   *
   * A signal never opens the gate. Being told something is not being addressed,
   * and the microphone's state is not the notification system's business.
   */
  async announce(text: string): Promise<void> {
    // During a reconnect gap the socket cannot carry text. Queue it instead of
    // silently dropping — an answer that arrives mid-redial survives the gap
    // and is spoken when the connection returns, never swallowed.
    if (!this.#session.connected) {
      this.#pendingAnnouncements.push(text);
      return;
    }
    const wasMuted = this.#session.muted;
    if (wasMuted) this.#session.unmute();
    try {
      this.#setState("speaking");
      await this.#session.sendText(text);
      this.#emit({ type: "caption", text, speaker: "assistant" });
    } finally {
      if (wasMuted) this.#session.mute();
    }
  }

  /** Provider callbacks, wired by whoever builds the session. */
  get realtimeEvents() {
    return {
      onAudio: (chunk: Uint8Array) => {
        void this.#mouth.speak({
          id: `speech-${Date.now()}`,
          kind: "speech" as const,
          play: (signal) => this.#speaker.play(chunk, signal),
        });
        this.#setState("speaking");
      },
      onTranscript: (text: string, speaker: "user" | "assistant") => {
        this.#emit({ type: "caption", text, speaker });
      },
      onFunctionCall: (call: FunctionCall) => {
        void this.#onFunctionCall(call);
      },
      // The one permitted interruption, passed straight through.
      onBargeIn: () => this.#mouth.barge(),
      // The socket came back. Flush anything that was queued during the gap.
      onReconnect: () => this.#flushPending(),
    };
  }

  #onWake(hearing: Hearing): void {
    // Reading `connected` before unmute(), because unmute is also the
    // transport's cue to redial immediately — afterwards the gap may
    // already be closing, and the answer here decides whether a covering
    // clip is owed.
    const wasDisconnected = !this.#session.connected;
    this.#session.unmute();
    this.#setState("listening");
    if (hearing.transcript) {
      this.#emit({ type: "caption", text: hearing.transcript, speaker: "user" });
    }
    // The mood goes to the faces and nowhere else. Not to the realtime provider
    // below, which is only ever handed audio and text the person actually said;
    // not to the hub's agent, whose thread is written to disk; not to a field on
    // this object. The next utterance replaces it and no record of this one
    // survives anywhere in the process.
    this.#emit({ type: "mood", mood: hearing.sentiment });
    if (wasDisconnected) {
      // Somebody spoke into a reconnect gap. The honest sound is "one
      // moment" — a thinking clip whose duration is spent on the redial
      // handshake, the same trade the hub filler makes with its round trip.
      void this.#playCoveringClip();
      return;
    }
    // A wake that was already actionable gets its filler now rather than waiting
    // for the provider to decide it needs the hub: the round trip has started.
    if (isActionable(hearing.intent)) void this.#playFiller(hearing);
  }

  #onQuiet(): void {
    this.#session.mute();
    this.#setState("idle");
    // Going quiet returns the orb to its resting colour. The conversation that
    // the mood was read from is over, so continuing to wear it would be the orb
    // remembering how somebody sounded — which is the one thing it must not do.
    this.#emit({ type: "mood", mood: "neutral" });
  }

  async #playFiller(hearing: Hearing): Promise<void> {
    const clip = await this.#bank.clipFor(hearing.intent);
    if (!clip) return;
    await this.#mouth.speak(clipUtterance(clip, this.#speaker));
  }

  async #playCoveringClip(): Promise<void> {
    const clip = await this.#bank.clipFrom("thinking");
    if (!clip) return;
    await this.#mouth.speak(clipUtterance(clip, this.#speaker));
  }

  /**
   * The provider asked for the hub. This is the only way anything gets done.
   *
   * An immediate acknowledgment is returned so the provider keeps its voice —
   * the hub turn then runs in the background and the answer is injected as a
   * spoken text signal when it resolves. The provider is never left waiting
   * in dead air for a result that may take minutes. Filler covers the first
   * beat; progress signals carry the rest; the answer speaks last.
   */
  async #onFunctionCall(call: FunctionCall): Promise<void> {
    const request = call.args.request?.trim();
    if (!request) {
      await this.#session.sendFunctionResult(call.id, "No request was provided.");
      return;
    }

    this.#setState("thinking");
    // The one hop where voice becomes action deserves a line in the log:
    // "the provider refused by itself" and "the hub refused" are different
    // defects, and without this line they are indistinguishable from outside.
    console.log(`[orb] ask_the_hub: ${JSON.stringify(request)}`);

    await this.#session.sendFunctionResult(call.id, DISPATCH_ACK);

    void this.#dispatch(request);
  }

  /**
   * Run the hub turn in the background and inject the answer (and any progress
   * signals) as spoken text when they arrive. Tracked by a dispatch id so the
   * orb knows what is in flight.
   */
  async #dispatch(request: string): Promise<void> {
    const id = ++this.#dispatchSeq;
    this.#pending.set(id, request);
    let answer: string;
    try {
      answer = await this.#brain.ask(request, (signal) => {
        void this.announce(PROGRESS_PREFIX + signal + PROGRESS_SUFFIX);
      });
      console.log(`[orb] hub answered (${answer.length} chars)`);
    } catch (error) {
      console.error(`[orb] hub threw: ${error instanceof Error ? error.message : String(error)}`);
      answer = "That did not work. Nothing was changed.";
    }
    this.#pending.delete(id);
    if (this.#closed) return;
    await this.announce(ANSWER_PREFIX + answer + ANSWER_SUFFIX);
  }

  /** Speak everything that was queued while the socket was down. */
  #flushPending(): void {
    if (this.#closed) {
      this.#pendingAnnouncements = [];
      return;
    }
    const pending = this.#pendingAnnouncements;
    this.#pendingAnnouncements = [];
    for (const text of pending) {
      void this.announce(text);
    }
  }

  #setState(state: OrbState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#emit({ type: "state", state });
  }

  #emit(event: OrbEvent): void {
    this.#onEvent(event);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#gate.close();
    this.#mouth.barge();
    await this.#session.close();
  }
}
