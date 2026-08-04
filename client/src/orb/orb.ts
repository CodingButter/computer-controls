/**
 * The orb, assembled.
 *
 * Everything the lane owns meets here: the hub-side wake gate, the realtime
 * session that is only a mouth and a pair of ears, the utterance bank that hides
 * the first second of latency, the single-file mouth, and the one function call
 * that reaches the actual brain.
 *
 * The order of operations in `#onFunctionCall` is the part worth reading. A
 * filler clip is queued *before* the agent is asked, and the agent's answer is
 * queued behind it — so the clip's duration is spent on the round trip instead
 * of on top of it, and the answer still cannot begin until the clip has
 * finished, because the mouth is a queue. Both of those are properties the issue
 * names, and they are the same property seen from two ends.
 */

import type { Hearing, Sentiment } from "./ear.ts";
import { isActionable } from "./ear.ts";
import { WakeGate, type GateDeps, type GateState } from "./gate.ts";
import type { FunctionCall, RealtimeSession } from "./live.ts";
import { Mouth, type Utterance } from "./mouth.ts";
import type { Clip, UtteranceBank } from "./utterance-bank.ts";

/** How the orb reaches the hub's agent: one call, text in, text out. */
export interface HubBrain {
  ask(request: string): Promise<string>;
}

/** Plays bytes on the machine's speaker. */
export interface Speaker {
  play(audio: Uint8Array, signal: AbortSignal): Promise<void>;
}

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
    };
  }

  #onWake(hearing: Hearing): void {
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

  /**
   * The provider asked for the hub. This is the only way anything gets done.
   *
   * The answer is handed back to the provider rather than spoken here, so the
   * response comes out in the same voice and with the same prosody as the rest
   * of the conversation — the provider is the mouth, including for words it did
   * not choose.
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
    let answer: string;
    try {
      answer = await this.#brain.ask(request);
      console.log(`[orb] hub answered (${answer.length} chars)`);
    } catch (error) {
      console.error(`[orb] hub threw: ${error instanceof Error ? error.message : String(error)}`);
      answer = "That did not work. Nothing was changed.";
    }
    await this.#session.sendFunctionResult(call.id, answer);
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
    this.#gate.close();
    this.#mouth.barge();
    await this.#session.close();
  }
}
