import { describe, expect, it, vi } from "vitest";

import type { Gesture, StateEvent } from "../events/types.ts";
import { ScriptedEventSource } from "../events/source.ts";
import { createWakeWordClassifier, type AudioFrame, type LocalEar, type VoiceActivityDetector } from "./ear.ts";
import { alwaysWakeWord } from "./ear-poc.ts";
import type { RealtimeSession } from "./live.ts";
import { Mouth } from "./mouth.ts";
import { Orb, type OrbEvent, type Speaker } from "./orb.ts";
import { UtteranceBank, type Clip, type ClipStore } from "./utterance-bank.ts";
import { OrbFaceSource, chooseFaceSource, toStateEvent } from "./face-source.ts";

/**
 * A minimal orb fan-out for the adapter tests: a Set of listeners with a
 * subscribe that adds and an unsubscribe that removes — the same shape
 * `mountOrb` and `routes.test.ts` use.
 */
function fakeOrbEvents() {
  const listeners = new Set<(event: OrbEvent) => void>();
  const emit = (event: OrbEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const subscribe = (listener: (event: OrbEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return { listeners, emit, subscribe };
}

describe("toStateEvent", () => {
  it("maps the four orb states onto the face vocabulary", () => {
    expect(toStateEvent({ type: "state", state: "listening" })).toEqual({ type: "wake_opened" });
    expect(toStateEvent({ type: "state", state: "thinking" })).toEqual({ type: "thinking" });
    expect(toStateEvent({ type: "state", state: "speaking" })).toEqual({ type: "speaking" });
    expect(toStateEvent({ type: "state", state: "idle" })).toEqual({ type: "idle" });
  });

  it("forwards a caption's text and drops its speaker", () => {
    expect(toStateEvent({ type: "caption", text: "hello", speaker: "user" })).toEqual({
      type: "caption",
      text: "hello",
    });
    expect(toStateEvent({ type: "caption", text: "world", speaker: "assistant" })).toEqual({
      type: "caption",
      text: "world",
    });
  });

  it("produces nothing for a mood event — the face has no mood word", () => {
    expect(toStateEvent({ type: "mood", mood: "neutral" })).toBeUndefined();
    expect(toStateEvent({ type: "mood", mood: "excited" })).toBeUndefined();
  });
});

describe("OrbFaceSource", () => {
  it("forwards each translated orb state to every subscribed face", () => {
    const orb = fakeOrbEvents();
    const source = new OrbFaceSource({
      subscribe: orb.subscribe,
      closeGate: () => {},
    });

    const received: StateEvent[] = [];
    source.subscribe((event) => received.push(event));

    orb.emit({ type: "state", state: "listening" });
    orb.emit({ type: "state", state: "thinking" });
    orb.emit({ type: "state", state: "speaking" });
    orb.emit({ type: "state", state: "idle" });

    expect(received).toEqual([
      { type: "wake_opened" },
      { type: "thinking" },
      { type: "speaking" },
      { type: "idle" },
    ]);
  });

  it("forwards captions but produces no frame for mood", () => {
    const orb = fakeOrbEvents();
    const source = new OrbFaceSource({
      subscribe: orb.subscribe,
      closeGate: () => {},
    });

    const received: StateEvent[] = [];
    source.subscribe((event) => received.push(event));

    orb.emit({ type: "caption", text: "turn on the lights", speaker: "user" });
    orb.emit({ type: "mood", mood: "neutral" });

    // The caption crossed; the mood produced nothing.
    expect(received).toEqual([{ type: "caption", text: "turn on the lights" }]);
  });

  it("routes mute and dismiss to closeGate, and leaves drag alone", () => {
    const closeGate = vi.fn();
    const source = new OrbFaceSource({
      subscribe: () => () => {},
      closeGate,
    });

    const mute: Gesture = { type: "mute" };
    const dismiss: Gesture = { type: "dismiss" };
    const drag: Gesture = { type: "drag", x: 10, y: 20 };

    source.handleGesture(mute);
    source.handleGesture(dismiss);
    source.handleGesture(dismiss);
    source.handleGesture(drag);
    source.handleGesture(mute);

    // Mute and dismiss each close; drag is a no-op.
    expect(closeGate).toHaveBeenCalledTimes(4);
  });

  it("counts each subscription as a real listener on the orb", () => {
    const orb = fakeOrbEvents();
    const source = new OrbFaceSource({
      subscribe: orb.subscribe,
      closeGate: () => {},
    });

    expect(orb.listeners.size).toBe(0);

    const unsubA = source.subscribe(() => {});
    expect(orb.listeners.size).toBe(1);

    const unsubB = source.subscribe(() => {});
    expect(orb.listeners.size).toBe(2);

    unsubA();
    expect(orb.listeners.size).toBe(1);

    unsubB();
    expect(orb.listeners.size).toBe(0);
  });

  it("stops delivering to a face after it unsubscribes", () => {
    const orb = fakeOrbEvents();
    const source = new OrbFaceSource({
      subscribe: orb.subscribe,
      closeGate: () => {},
    });

    const received: StateEvent[] = [];
    const unsubscribe = source.subscribe((event) => received.push(event));

    orb.emit({ type: "state", state: "listening" });
    unsubscribe();
    orb.emit({ type: "state", state: "thinking" });

    expect(received).toEqual([{ type: "wake_opened" }]);
  });
});

describe("chooseFaceSource", () => {
  it("builds an OrbFaceSource when the orb is live", () => {
    const orb = { closeGate: vi.fn() };
    const subscribe = () => () => {};
    const source = chooseFaceSource({ orb, subscribe });
    expect(source).toBeInstanceOf(OrbFaceSource);
  });

  it("falls back to the scripted source when the orb is refused", () => {
    // A refused orb has neither `orb` nor `subscribe` — both travel together
    // only on a live mount.
    expect(chooseFaceSource({})).toBeInstanceOf(ScriptedEventSource);
    expect(chooseFaceSource({ subscribe: () => () => {} })).toBeInstanceOf(ScriptedEventSource);
    // An orb without a subscribe is also refused — subscribe is what a live
    // mount offers alongside the orb.
    expect(chooseFaceSource({ orb: { closeGate: () => {} } })).toBeInstanceOf(ScriptedEventSource);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: a real Orb driven through its actual state machine, with
// the adapter wired to its events the same way mountOrb wires them. These prove
// the three acceptance criteria from issue #118 end-to-end.
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16_000;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function frame(): AudioFrame {
  return { samples: new Int16Array(SAMPLE_RATE / 10), sampleRate: SAMPLE_RATE };
}

function controllableVad(): VoiceActivityDetector & { speaking: boolean } {
  return {
    speaking: false,
    isSpeech(this: { speaking: boolean }) {
      return this.speaking;
    },
    reset: () => {},
  };
}

function fakeSession(): RealtimeSession & {
  audio: Uint8Array[];
  texts: string[];
  results: { id: string; result: string }[];
} {
  let muted = false;
  const audio: Uint8Array[] = [];
  const texts: string[] = [];
  const results: { id: string; result: string }[] = [];
  return {
    audio,
    texts,
    results,
    sendAudio: (chunk) => audio.push(chunk),
    sendText: async (text) => {
      texts.push(text);
    },
    sendFunctionResult: async (id, result) => {
      results.push({ id, result });
    },
    mute: () => {
      muted = true;
    },
    unmute: () => {
      muted = false;
    },
    get muted() {
      return muted;
    },
    connected: true,
    close: async () => {},
  };
}

function bankHolding(clips: Clip[]): UtteranceBank {
  const map = new Map(clips.map((clip) => [clip.id, clip]));
  const store: ClipStore = {
    read: async (id) => map.get(id),
    write: async () => {},
    list: async () => [...map.keys()],
  };
  return new UtteranceBank(store, () => 0);
}

async function say(orb: Orb, vad: { speaking: boolean }, speech = 10, silence = 8) {
  vad.speaking = true;
  for (let i = 0; i < speech; i += 1) await orb.push(frame());
  vad.speaking = false;
  for (let i = 0; i < silence; i += 1) await orb.push(frame());
}

/**
 * Builds a real Orb with a fan-out onEvent (the same closure shape mountOrb
 * uses) and an OrbFaceSource wired to it. Everything behind the adapter is the
 * genuine state machine — the adapter is the only thing under test.
 */
function buildLiveOrb(options: { transcript?: string } = {}) {
  const listeners = new Set<(event: OrbEvent) => void>();
  const subscribe = (listener: (event: OrbEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const vad = controllableVad();
  const ear: LocalEar = {
    languages: ["en"],
    transcribe: async () => options.transcript ?? "mastra open the browser",
  };
  const session = fakeSession();
  const played: string[] = [];
  const speaker: Speaker = {
    play: async (audio) => {
      played.push(new TextDecoder().decode(audio));
    },
  };
  const ask = vi.fn(async (request: string) => `did: ${request}`);

  const orb = new Orb({
    gate: { vad, ear, classifier: createWakeWordClassifier(), wakeWord: alwaysWakeWord },
    session,
    bank: bankHolding([
      { id: "acknowledge-0", class: "acknowledge", audio: new TextEncoder().encode("on it"), durationMs: 400 },
      { id: "thinking-0", class: "thinking", audio: new TextEncoder().encode("let me check"), durationMs: 500 },
    ]),
    mouth: new Mouth(),
    speaker,
    brain: { ask },
    onEvent: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
  });

  const source = new OrbFaceSource({ subscribe, closeGate: () => orb.closeGate() });
  return { orb, source, vad, session, played, listeners };
}

describe("OrbFaceSource over a real orb", () => {
  // Acceptance #1: the adapter forwards the full state cycle.
  it("forwards listening → thinking → speaking → idle onto the face pipe", async () => {
    const { orb, source, vad } = buildLiveOrb();
    const received: StateEvent[] = [];
    source.subscribe((event) => received.push(event));

    await say(orb, vad);
    await tick();
    orb.realtimeEvents.onFunctionCall({ id: "c", name: "ask_the_hub", args: { request: "open the browser" } });
    await tick();
    orb.realtimeEvents.onAudio(new TextEncoder().encode("done"));
    orb.closeGate();

    const states = received.filter(
      (e): e is { type: "wake_opened" | "thinking" | "speaking" | "idle" } =>
        e.type === "wake_opened" || e.type === "thinking" || e.type === "speaking" || e.type === "idle",
    );
    expect(states).toEqual([
      { type: "wake_opened" },
      { type: "thinking" },
      { type: "speaking" },
      { type: "idle" },
    ]);
  });

  // Acceptance #2: captions cross verbatim; mood never does.
  it("crosses captions verbatim and produces no frame for mood", async () => {
    const { orb, source, vad } = buildLiveOrb();
    const received: StateEvent[] = [];
    source.subscribe((event) => received.push(event));

    await say(orb, vad);
    await tick();

    // The wake word transcript crossed as a caption — text intact, speaker gone.
    expect(received).toContainEqual({ type: "caption", text: "mastra open the browser" });

    // closeGate fires onQuiet, which emits a mood event alongside the idle
    // state. The mood must produce no frame — only idle arrives.
    const before = received.length;
    orb.closeGate();
    expect(received.slice(before)).toEqual([{ type: "idle" }]);
  });

  // Acceptance #3: mute and dismiss close the gate; a closed gate stays closed.
  it("closes the gate on mute and dismiss, and a closed gate stays closed", async () => {
    const { orb, source, vad } = buildLiveOrb();

    await say(orb, vad);
    await tick();
    expect(orb.gateState).toBe("open");

    source.handleGesture({ type: "mute" });
    expect(orb.gateState).toBe("idle");

    // A second mute on an already-closed gate: stays closed, no error.
    source.handleGesture({ type: "mute" });
    expect(orb.gateState).toBe("idle");

    // Re-wake, then dismiss closes the gate too.
    await say(orb, vad);
    await tick();
    expect(orb.gateState).toBe("open");

    source.handleGesture({ type: "dismiss" });
    expect(orb.gateState).toBe("idle");
  });
});
