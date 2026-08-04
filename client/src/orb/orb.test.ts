import { describe, expect, it, vi } from "vitest";

import { createHubBrain } from "./brain.ts";
import { createWakeWordClassifier, type AudioFrame, type LocalEar, type VoiceActivityDetector } from "./ear.ts";
import type { RealtimeSession } from "./live.ts";
import { Mouth } from "./mouth.ts";
import { Orb, type OrbEvent, type Speaker } from "./orb.ts";
import { UtteranceBank, type Clip, type ClipStore } from "./utterance-bank.ts";

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
  connected: boolean;
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

function build(options: { transcript?: string; answer?: string } = {}) {
  const vad = controllableVad();
  const ear: LocalEar = {
    languages: ["en"],
    transcribe: async () => options.transcript ?? "computer open the browser",
  };
  const session = fakeSession();
  const played: string[] = [];
  const speaker: Speaker = {
    play: async (audio) => {
      played.push(new TextDecoder().decode(audio));
    },
  };
  const ask = vi.fn(async (request: string) => options.answer ?? `did: ${request}`);
  const events: OrbEvent[] = [];
  const orb = new Orb({
    gate: { vad, ear, classifier: createWakeWordClassifier() },
    session,
    bank: bankHolding([
      { id: "acknowledge-0", class: "acknowledge", audio: new TextEncoder().encode("on it"), durationMs: 400 },
      { id: "thinking-0", class: "thinking", audio: new TextEncoder().encode("let me check"), durationMs: 500 },
    ]),
    mouth: new Mouth(),
    speaker,
    brain: { ask },
    onEvent: (event) => events.push(event),
  });
  return { orb, session, vad, played, ask, events };
}

async function say(orb: Orb, vad: { speaking: boolean }, speech = 10, silence = 8) {
  vad.speaking = true;
  for (let i = 0; i < speech; i += 1) await orb.push(frame());
  vad.speaking = false;
  for (let i = 0; i < silence; i += 1) await orb.push(frame());
}

describe("test_idle_mode_sends_no_audio_off_the_machine", () => {
  it("keeps the realtime session muted and unfed while idle", async () => {
    const { orb, session, vad } = build({ transcript: "just talking to myself" });

    expect(session.muted).toBe(true);
    await say(orb, vad);

    expect(session.audio).toHaveLength(0);
    expect(session.muted).toBe(true);
    expect(orb.state).toBe("idle");
  });

  it("unmutes only once the gate has opened", async () => {
    const { orb, session, vad } = build();

    await say(orb, vad);

    expect(session.muted).toBe(false);
    expect(orb.gateState).toBe("open");
  });
});

describe("test_actionable_requests_route_to_the_pack_brain_as_one_function_call", () => {
  it("hands the request to the hub agent and returns the answer to the provider", async () => {
    const { orb, session, ask } = build();

    orb.realtimeEvents.onFunctionCall({
      id: "call-1",
      name: "ask_the_hub",
      args: { request: "open the browser" },
    });
    await tick();

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith("open the browser");
    expect(session.results).toEqual([{ id: "call-1", result: "did: open the browser" }]);
  });

  it("speaks the answer through the provider rather than out of a second mouth", async () => {
    const { orb, session, played } = build();

    orb.realtimeEvents.onFunctionCall({ id: "c", name: "ask_the_hub", args: { request: "x" } });
    await tick();

    // The answer went back down the socket; nothing was synthesized locally, so
    // the response comes out in the same voice as the rest of the conversation.
    expect(session.results).toHaveLength(1);
    expect(played).not.toContain("did: x");
  });

  it("survives a brain that throws, and says so rather than going silent", async () => {
    const session = fakeSession();
    const failing = new Orb({
      gate: {
        vad: controllableVad(),
        ear: { languages: ["en"], transcribe: async () => "" },
        classifier: createWakeWordClassifier(),
      },
      session,
      bank: bankHolding([]),
      mouth: new Mouth(),
      speaker: { play: async () => {} },
      brain: {
        ask: async () => {
          throw new Error("model unavailable");
        },
      },
    });

    failing.realtimeEvents.onFunctionCall({ id: "c", name: "ask_the_hub", args: { request: "x" } });
    await tick();

    expect(session.results[0]?.result).toMatch(/did not work/i);
    // And the failure never becomes a claim that something happened.
    expect(session.results[0]?.result).toMatch(/nothing was changed/i);
  });

  it("refuses an empty request instead of waking the brain for nothing", async () => {
    const { orb, session, ask } = build();

    orb.realtimeEvents.onFunctionCall({ id: "c", name: "ask_the_hub", args: { request: "  " } });
    await tick();

    expect(ask).not.toHaveBeenCalled();
    expect(session.results[0]?.result).toMatch(/no request/i);
  });
});

describe("test_a_signal_injected_as_text_is_spoken_by_the_orb", () => {
  it("pushes a signal into the live session as a text turn", async () => {
    const { orb, session } = build();

    await orb.announce("The build finished.");

    expect(session.texts).toEqual(["The build finished."]);
  });

  it("returns the session to muted afterwards, so a signal never opens the microphone", async () => {
    const { orb, session } = build();

    expect(session.muted).toBe(true);
    await orb.announce("The build finished.");

    // Being told something is not being addressed: the notification path has no
    // business changing what the microphone is doing.
    expect(session.muted).toBe(true);
    expect(orb.gateState).toBe("idle");
  });

  it("captions what it announced, so the drawer shows what was said", async () => {
    const { orb, events } = build();

    await orb.announce("The build finished.");

    expect(events).toContainEqual({
      type: "caption",
      text: "The build finished.",
      speaker: "assistant",
    });
  });

  it("leaves an already-open session open rather than muting it mid-conversation", async () => {
    const { orb, session, vad } = build();
    await say(orb, vad);
    expect(session.muted).toBe(false);

    await orb.announce("By the way, the build finished.");

    expect(session.muted).toBe(false);
  });
});

describe("test_a_filler_clip_plays_from_cache_and_never_from_a_live_synth_call", () => {
  it("plays the acknowledgement while the request is still in flight", async () => {
    const { orb, vad, played } = build({ transcript: "computer open the browser" });

    await say(orb, vad);
    await tick();

    expect(played).toEqual(["on it"]);
  });

  it("says nothing at all before small talk", async () => {
    const { orb, vad, played } = build({ transcript: "computer nice to see you" });

    await say(orb, vad);
    await tick();

    expect(played).toEqual([]);
  });

  it("covers a reconnect gap with a thinking clip instead of dead air", async () => {
    const { orb, session, vad, played } = build({ transcript: "computer open the browser" });
    session.connected = false;

    await say(orb, vad);
    await tick();

    // The person spoke into a gap. They hear "one moment", not the command
    // acknowledgement — nothing was heard on the far side to acknowledge.
    expect(played).toEqual(["let me check"]);
  });
});

describe("the orb's own state, as the faces see it", () => {
  it("moves idle → listening → thinking as the work progresses", async () => {
    const { orb, vad, events } = build();

    await say(orb, vad);
    orb.realtimeEvents.onFunctionCall({ id: "c", name: "ask_the_hub", args: { request: "x" } });
    await tick();

    const states = events.filter((e) => e.type === "state").map((e) => e.state);
    expect(states).toContain("listening");
    expect(states).toContain("thinking");
  });

  it("captions the user's own words from the local transcript", async () => {
    const { orb, vad, events } = build({ transcript: "computer open the browser" });

    await say(orb, vad);

    expect(events).toContainEqual({
      type: "caption",
      text: "computer open the browser",
      speaker: "user",
    });
  });

  it("passes a barge-in straight through to the mouth", async () => {
    const mouth = new Mouth();
    const barge = vi.spyOn(mouth, "barge");
    const orb = new Orb({
      gate: {
        vad: controllableVad(),
        ear: { languages: ["en"], transcribe: async () => "" },
        classifier: createWakeWordClassifier(),
      },
      session: fakeSession(),
      bank: bankHolding([]),
      mouth,
      speaker: { play: async () => {} },
      brain: { ask: async () => "" },
    });

    orb.realtimeEvents.onBargeIn();

    expect(barge).toHaveBeenCalled();
  });

  it("toggles the gate by hand when the orb is tapped", () => {
    const { orb, session } = build();

    orb.toggle();
    expect(orb.gateState).toBe("open");
    expect(session.muted).toBe(false);

    orb.toggle();
    expect(orb.gateState).toBe("idle");
    expect(session.muted).toBe(true);
  });
});

describe("the one function call lands on the same agent the chat page uses", () => {
  it("runs the request as an ordinary turn, on the shared thread", async () => {
    const turn = vi.fn(async () => ({ text: "done", threadId: "t-1", status: "ok" }));
    const brain = createHubBrain({ turn, threadId: () => "t-1" });

    const answer = await brain.ask("open the browser");

    expect(turn).toHaveBeenCalledWith({ message: "open the browser", threadId: "t-1" });
    expect(answer).toBe("done");
  });

  it("says something rather than nothing when the turn comes back empty", async () => {
    const brain = createHubBrain({
      turn: async () => ({ text: "   ", status: "ok" }),
    });

    await expect(brain.ask("x")).resolves.toMatch(/nothing to report/i);
  });
});
