import { describe, expect, it, vi } from "vitest";

import type { AudioFrame, VoiceActivityDetector, WakeWordDetector } from "./ear.ts";
import { WakeGate } from "./gate.ts";

const SAMPLE_RATE = 16_000;

/** A 100ms frame. Content is irrelevant — the fake detectors decide, not the bytes. */
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

/**
 * A wake-word detector the test drives directly, counting the utterances it was
 * asked about.
 *
 * The real one compares cepstral shapes; what the gate needs from it is a
 * yes or a no, and how often it was consulted is the thing several of these
 * tests are actually about.
 */
function controllableWakeWord(): WakeWordDetector & { wakeHeard: boolean; asked: AudioFrame[] } {
  return {
    wakeHeard: true,
    asked: [] as AudioFrame[],
    heard(this: { wakeHeard: boolean; asked: AudioFrame[] }, utterance: AudioFrame) {
      this.asked.push(utterance);
      return this.wakeHeard;
    },
    reset: vi.fn(),
  };
}

function build(
  options: {
    quietPeriodMs?: number;
    wakeWord?: WakeWordDetector & { wakeHeard: boolean; asked: AudioFrame[] };
    hold?: () => boolean;
  } = {},
) {
  const vad = controllableVad();
  const wakeWord = options.wakeWord ?? controllableWakeWord();
  const events = { onOpen: vi.fn(), onIdle: vi.fn(), onForward: vi.fn() };
  const gate = new WakeGate({
    vad,
    wakeWord,
    events,
    ...(options.quietPeriodMs === undefined ? {} : { quietPeriodMs: options.quietPeriodMs }),
    ...(options.hold === undefined ? {} : { hold: options.hold }),
  });
  return { gate, events, vad, wakeWord };
}

/** Speech frames, then the silence that ends an utterance and triggers the match. */
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
  it("forwards nothing when what was said was not the phrase", async () => {
    const wakeWord = controllableWakeWord();
    wakeWord.wakeHeard = false;
    const { gate, events, vad } = build({ wakeWord });

    await say(gate, vad);

    expect(wakeWord.asked).toHaveLength(1);
    expect(events.onForward).not.toHaveBeenCalled();
    expect(events.onOpen).not.toHaveBeenCalled();
    expect(gate.state).toBe("idle");
  });

  it("never troubles the matcher when the room is simply silent", async () => {
    const { gate, events, vad, wakeWord } = build();

    vad.speaking = false;
    for (let i = 0; i < 50; i += 1) await gate.push(frame());

    expect(events.onForward).not.toHaveBeenCalled();
    // Silence does not reach tier 1, which is the whole reason tier 0 exists.
    expect(wakeWord.asked).toHaveLength(0);
  });

  it("drops an endlessly talking room instead of buffering it or matching it", async () => {
    const { gate, events, vad, wakeWord } = build();

    // 200 frames of unbroken speech is 20s — past the ceiling, and never ended
    // by a silence, so the buffer is discarded rather than matched.
    vad.speaking = true;
    for (let i = 0; i < 200; i += 1) await gate.push(frame());

    expect(wakeWord.asked).toHaveLength(0);
    expect(events.onForward).not.toHaveBeenCalled();
    expect(gate.isOpen).toBe(false);
  });

  it("holds the property across many utterances in a row that were not the phrase", async () => {
    const wakeWord = controllableWakeWord();
    wakeWord.wakeHeard = false;
    const { gate, events, vad } = build({ wakeWord });

    for (let i = 0; i < 5; i += 1) await say(gate, vad);

    expect(wakeWord.asked).toHaveLength(5);
    expect(events.onForward).not.toHaveBeenCalled();
  });

  it("never asks about a blip too short to be a word", async () => {
    const { gate, events, vad, wakeWord } = build();

    // One 100ms frame of "speech" — a chair creak — then the silence that ends
    // it. Under the floor, so the matcher is never run on it at all.
    await say(gate, vad, 1, 8);

    expect(wakeWord.asked).toHaveLength(0);
    expect(events.onOpen).not.toHaveBeenCalled();
  });
});

describe("test_the_wake_gate_opens_only_when_the_shape_says_so", () => {
  it("opens when the utterance matches the phrase, and hands that audio on", async () => {
    const { gate, events, vad, wakeWord } = build();

    await say(gate, vad);

    expect(wakeWord.asked).toHaveLength(1);
    // The utterance rides out with the opening, because it is usually the
    // question as well as the name. Nothing wrote down what it said.
    const [waking] = events.onOpen.mock.calls[0] ?? [];
    expect(waking.utterance).toBe(wakeWord.asked[0]);
    expect(gate.isOpen).toBe(true);
  });

  it("hands the matcher the whole utterance, pauses and all", async () => {
    const { gate, vad, wakeWord } = build();

    await say(gate, vad, 12, 8);

    // Buffered frames, not just the loud ones: a phrase with the gaps cut out
    // is a waveform nobody said, and the shape would not survive it. Twelve
    // frames of speech plus the six of silence that ended the utterance —
    // the trailing silence is part of what was buffered, not trimmed off.
    const [utterance] = wakeWord.asked;
    expect(utterance).toBeDefined();
    expect(utterance!.sampleRate).toBe(SAMPLE_RATE);
    expect(utterance!.samples.length).toBe((SAMPLE_RATE / 10) * 18);
  });

  it("forwards audio only after the gate opened, never before", async () => {
    const vad = controllableVad();
    // Ordering, not counting, is the property: once the gate is open, silence
    // frames forward too, so the honest assertion is that nothing was forwarded
    // before `onOpen` fired — not that some particular number of frames was.
    const log: ("open" | "forward")[] = [];
    const gate = new WakeGate({
      vad,
      wakeWord: controllableWakeWord(),
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

  it("drops back to idle after the quiet period and stops forwarding", async () => {
    const { gate, events, vad } = build({ quietPeriodMs: 300 });

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

  it("stays open through the quiet period while held — a listener is not gone", async () => {
    let mouthSpeaking = true;
    const { gate, events, vad } = build({
      quietPeriodMs: 300,
      hold: () => mouthSpeaking,
    });

    await say(gate, vad);
    expect(gate.isOpen).toBe(true);

    // Silence long past the quiet period, but the mouth is mid-answer: the
    // user is listening, and the gate must not hang up on its own voice.
    vad.speaking = false;
    for (let i = 0; i < 10; i += 1) await gate.push(frame());
    expect(gate.isOpen).toBe(true);
    expect(events.onIdle).not.toHaveBeenCalled();

    // The answer ends. The quiet period that follows is a FULL one — the
    // clock restarted at the last hold, so two more frames of silence are
    // not enough to close the gate...
    mouthSpeaking = false;
    await gate.push(frame());
    await gate.push(frame());
    expect(gate.isOpen).toBe(true);

    // ...but a full quiet period of silence after the answer is.
    await gate.push(frame());
    expect(gate.state).toBe("idle");
    expect(events.onIdle).toHaveBeenCalled();
  });

  it("does not re-decide mid-sentence once it has opened", async () => {
    const { gate, events, vad, wakeWord } = build();

    await say(gate, vad);
    const forwardsSoFar = events.onForward.mock.calls.length;
    const asksSoFar = wakeWord.asked.length;

    vad.speaking = true;
    for (let i = 0; i < 20; i += 1) await gate.push(frame());

    // Every one of those 20 frames went straight out, and the matcher was not
    // consulted again — a gate that re-decided would cut a person off.
    expect(events.onForward).toHaveBeenCalledTimes(forwardsSoFar + 20);
    expect(wakeWord.asked).toHaveLength(asksSoFar);
  });
});

describe("test_a_closed_gate_needs_no_second_opinion", () => {
  it("opens on the shape alone, with no transcription anywhere in the path", async () => {
    const { gate, events, vad } = build();

    await say(gate, vad);

    // Nothing here reads words. The failure this replaces was a small local
    // model rendering "hey mastra" as "he mastered" and refusing its owner;
    // there is no spelling left in the decision to get wrong.
    expect(gate.isOpen).toBe(true);
    const [waking] = events.onOpen.mock.calls[0] ?? [];
    expect(Object.keys(waking)).toEqual(["utterance"]);
  });

  it("closes and resets the matcher, so the next phrase is judged fresh", async () => {
    const { gate, vad, wakeWord } = build();

    await say(gate, vad);
    expect(gate.isOpen).toBe(true);

    gate.close();

    expect(gate.state).toBe("idle");
    expect(wakeWord.reset).toHaveBeenCalled();
  });
});

describe("test_a_tap_still_opens_the_gate_by_hand", () => {
  it("opens by hand when a person taps the orb, which is not idle by definition", () => {
    const { gate, events, wakeWord } = build();

    gate.openByHand();

    expect(gate.isOpen).toBe(true);
    expect(wakeWord.asked).toHaveLength(0);
    // Nothing to send ahead: a tap is a gesture, and the person has not
    // spoken yet.
    expect(events.onOpen).toHaveBeenCalledWith({ utterance: null });
  });
});
