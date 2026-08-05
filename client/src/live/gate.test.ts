import { describe, expect, it, vi } from "vitest";

import {
  createWakeWordClassifier,
  type AudioFrame,
  type LocalEar,
  type VoiceActivityDetector,
  type WakeWordDetector,
} from "./ear.ts";
import { WakeGate } from "./gate.ts";

const SAMPLE_RATE = 16_000;

/** A 100ms frame. Content is irrelevant — the fake detector decides, not the bytes. */
function frame(): AudioFrame {
  return { samples: new Int16Array(SAMPLE_RATE / 10), sampleRate: SAMPLE_RATE };
}

/**
 * A detector the test drives directly.
 *
 * Speech is a decision here rather than a waveform, so these tests prove the
 * gate's logic without pinning it to any particular detector's behaviour — which
 * is the same reason the gate takes the detector as an interface.
 */
function controllableVad(): VoiceActivityDetector & { speaking: boolean } {
  return {
    speaking: false,
    isSpeech(this: { speaking: boolean }) {
      return this.speaking;
    },
    reset: vi.fn(),
  };
}

function earHearing(transcript: string, languages: readonly string[] = ["en"]): LocalEar {
  return { languages, transcribe: vi.fn(async () => transcript) };
}

/**
 * A wake-word detector the test drives directly.
 *
 * Defaults to hearing the name, so existing open-path tests pass without each
 * caller wiring it; a test that wants speech-without-the-name flips wakeHeard.
 */
function controllableWakeWord(): WakeWordDetector & { wakeHeard: boolean } {
  return {
    wakeHeard: true,
    heard(this: { wakeHeard: boolean }) {
      return this.wakeHeard;
    },
    reset: vi.fn(),
  };
}

function build(
  ear: LocalEar,
  options: { quietPeriodMs?: number; wakeWord?: WakeWordDetector } = {},
) {
  const vad = controllableVad();
  const wakeWord = options.wakeWord ?? controllableWakeWord();
  const events = { onOpen: vi.fn(), onIdle: vi.fn(), onForward: vi.fn() };
  const gate = new WakeGate({
    vad,
    wakeWord,
    ear,
    classifier: createWakeWordClassifier(),
    events,
    ...(options.quietPeriodMs === undefined ? {} : { quietPeriodMs: options.quietPeriodMs }),
  });
  return { gate, events, vad, wakeWord };
}

/** Speech frames, then the silence that ends an utterance and triggers the ear. */
async function say(
  gate: WakeGate,
  vad: { speaking: boolean },
  speechFrames = 10,
  silenceFrames = 8,
) {
  vad.speaking = true;
  for (let i = 0; i < speechFrames; i += 1) await gate.push(frame());
  vad.speaking = false;
  for (let i = 0; i < silenceFrames; i += 1) await gate.push(frame());
}

describe("test_idle_mode_sends_no_audio_off_the_machine", () => {
  it("forwards nothing when what was said was not addressed to us", async () => {
    const ear = earHearing("what a nice afternoon it is");
    const { gate, events, vad } = build(ear);

    await say(gate, vad);

    expect(ear.transcribe).toHaveBeenCalledTimes(1);
    expect(events.onForward).not.toHaveBeenCalled();
    expect(events.onOpen).not.toHaveBeenCalled();
    expect(gate.state).toBe("idle");
  });

  it("never troubles the ear when the room is simply silent", async () => {
    const ear = earHearing("mastra open the browser");
    const { gate, events, vad } = build(ear);

    vad.speaking = false;
    for (let i = 0; i < 50; i += 1) await gate.push(frame());

    expect(events.onForward).not.toHaveBeenCalled();
    // Silence does not reach tier 1, which is the whole reason tier 0 exists.
    expect(ear.transcribe).not.toHaveBeenCalled();
  });

  it("keeps the gate shut when the local ear fails, rather than opening blind", async () => {
    const ear: LocalEar = {
      languages: ["en"],
      transcribe: vi.fn(async () => {
        throw new Error("model failed to load");
      }),
    };
    const { gate, events, vad } = build(ear);

    await say(gate, vad);

    expect(ear.transcribe).toHaveBeenCalled();
    expect(events.onForward).not.toHaveBeenCalled();
    expect(gate.state).toBe("idle");
  });

  it("drops an endlessly talking room instead of buffering it or transcribing it", async () => {
    const ear = earHearing("mastra open the browser");
    const { gate, events, vad } = build(ear);

    // 200 frames of unbroken speech is 20s — past the ceiling, and never ended
    // by a silence, so the buffer is discarded rather than handed to the ear.
    vad.speaking = true;
    for (let i = 0; i < 200; i += 1) await gate.push(frame());

    expect(ear.transcribe).not.toHaveBeenCalled();
    expect(events.onForward).not.toHaveBeenCalled();
    expect(gate.isOpen).toBe(false);
  });

  it("holds the property across many unaddressed utterances in a row", async () => {
    const ear = earHearing("so then I told him it was fine");
    const { gate, events, vad } = build(ear);

    for (let i = 0; i < 5; i += 1) await say(gate, vad);

    expect(ear.transcribe).toHaveBeenCalledTimes(5);
    expect(events.onForward).not.toHaveBeenCalled();
  });
});

describe("test_the_wake_gate_opens_only_when_the_cheap_ear_says_so", () => {
  it("opens when the ear hears the assistant addressed", async () => {
    const ear = earHearing("mastra open the browser");
    const { gate, events, vad } = build(ear);

    await say(gate, vad);

    expect(ear.transcribe).toHaveBeenCalledTimes(1);
    expect(events.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ addressed: true, intent: "command" }),
    );
    expect(gate.isOpen).toBe(true);
  });

  it("forwards audio only after the ear said yes, never before", async () => {
    const ear = earHearing("mastra what time is it");
    const vad = controllableVad();
    // Ordering, not counting, is the property: once the gate is open, silence
    // frames forward too, so the honest assertion is that nothing was forwarded
    // before `onOpen` fired — not that some particular number of frames was.
    const log: ("open" | "forward")[] = [];
    const gate = new WakeGate({
      vad,
      wakeWord: controllableWakeWord(),
      ear,
      classifier: createWakeWordClassifier(),
      events: {
        onOpen: () => log.push("open"),
        onIdle: () => {},
        onForward: () => log.push("forward"),
      },
    });

    await say(gate, vad);
    await gate.push(frame());

    expect(log).toContain("open");
    expect(log).toContain("forward");
    expect(log.indexOf("open")).toBe(0);
    expect(log.indexOf("forward")).toBeGreaterThan(log.indexOf("open"));
  });

  it("stays shut for speech that was near us rather than to us", async () => {
    const ear = earHearing("nice weather we are having");
    const { gate, events, vad } = build(ear);

    await say(gate, vad);

    expect(ear.transcribe).toHaveBeenCalledTimes(1);
    expect(events.onOpen).not.toHaveBeenCalled();
  });

  it("classifies a bare wake word apart from a request", async () => {
    const ear = earHearing("mastra");
    const { gate, events, vad } = build(ear);

    await say(gate, vad);

    expect(events.onOpen).toHaveBeenCalledWith(expect.objectContaining({ intent: "bare-wake" }));
    expect(gate.isOpen).toBe(true);
  });

  it("drops back to idle after the quiet period and stops forwarding", async () => {
    const ear = earHearing("mastra open the browser");
    const { gate, events, vad } = build(ear, { quietPeriodMs: 300 });

    await say(gate, vad);
    expect(gate.isOpen).toBe(true);

    // Silence while open: three 100ms frames crosses the 300ms quiet period.
    vad.speaking = false;
    for (let i = 0; i < 4; i += 1) await gate.push(frame());

    expect(events.onIdle).toHaveBeenCalled();
    expect(gate.state).toBe("idle");

    const forwardsWhileOpen = events.onForward.mock.calls.length;
    await gate.push(frame());
    expect(events.onForward).toHaveBeenCalledTimes(forwardsWhileOpen);
  });

  it("does not re-decide mid-sentence once it has opened", async () => {
    const ear = earHearing("mastra open the browser");
    const { gate, events, vad } = build(ear);

    await say(gate, vad);
    const forwardsSoFar = events.onForward.mock.calls.length;
    ear.transcribe = vi.fn();

    vad.speaking = true;
    for (let i = 0; i < 20; i += 1) await gate.push(frame());

    // Every one of those 20 frames went straight out, and the ear was not
    // consulted again — a gate that re-decided would cut a person off.
    expect(events.onForward).toHaveBeenCalledTimes(forwardsSoFar + 20);
    expect(ear.transcribe).not.toHaveBeenCalled();
  });

  it("carries the licensed languages of whatever ear is installed", () => {
    const { gate } = build(earHearing("", ["en"]));
    expect(gate.languages).toEqual(["en"]);
  });
});

describe("test_speech_that_is_not_the_name_stays_home", () => {
  it("never reaches the ear when speech does not contain the wake word", async () => {
    const ear = earHearing("what a nice afternoon it is");
    const wakeWord = controllableWakeWord();
    wakeWord.wakeHeard = false;
    const { gate, events, vad } = build(ear, { wakeWord });

    await say(gate, vad);

    // The wake word was checked but answered no, so the ear was never consulted
    // and nothing left the machine.
    expect(ear.transcribe).not.toHaveBeenCalled();
    expect(events.onForward).not.toHaveBeenCalled();
    expect(events.onOpen).not.toHaveBeenCalled();
    expect(gate.state).toBe("idle");
  });
});

describe("test_the_name_opens_the_gate", () => {
  it("opens the gate when the name is heard and the speech is addressed to us", async () => {
    const ear = earHearing("mastra what time is it");
    const { gate, events, vad } = build(ear);

    await say(gate, vad);

    expect(events.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ addressed: true, intent: "question" }),
    );
    expect(gate.isOpen).toBe(true);

    // Frames forward while the gate is open.
    const forwardsBefore = events.onForward.mock.calls.length;
    vad.speaking = true;
    await gate.push(frame());
    expect(events.onForward.mock.calls.length).toBeGreaterThan(forwardsBefore);
  });
});

describe("test_talking_about_mastra_is_not_talking_to_mastra", () => {
  it("stays closed for talk about Mastra, opens for talk to Mastra", async () => {
    const transcripts = ["i was showing caleb how mastra works", "mastra what time is it"];
    let call = 0;
    const ear: LocalEar = {
      languages: ["en"],
      transcribe: vi.fn(async () => transcripts[call++] ?? ""),
    };
    const { gate, events, vad } = build(ear);

    // First utterance: talking ABOUT Mastra. The name appears mid-sentence, not
    // as a vocative at the start, so the classifier does not count it as addressed.
    await say(gate, vad);
    expect(ear.transcribe).toHaveBeenCalledTimes(1);
    expect(events.onOpen).not.toHaveBeenCalled();
    expect(gate.isOpen).toBe(false);

    // Second utterance: talking TO Mastra. The name leads, as a vocative.
    await say(gate, vad);
    expect(events.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ addressed: true, intent: "question" }),
    );
    expect(gate.isOpen).toBe(true);
  });
});

describe("test_a_tap_still_opens_the_gate_by_hand", () => {
  it("opens by hand when a person taps the orb, which is not idle by definition", () => {
    const { gate, events } = build(earHearing(""));

    gate.openByHand();

    expect(gate.isOpen).toBe(true);
    expect(events.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ addressed: true, transcript: "" }),
    );
  });
});
