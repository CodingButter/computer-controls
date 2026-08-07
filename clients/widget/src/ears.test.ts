// The ears' decisions, exercised without a browser: the chain is the hub's own
// gate around a fingerprint matcher, the templates come from the hub, and the
// plug answers the lane's voice words the way the arbitration design says.

import { describe, expect, test } from "vitest";
import { CAPTURE_RATE, createEarChain, loadWakeWord, plugDecision } from "./ears.js";
import { alwaysWakeWord, deafWakeWord } from "./vendor/live/ear-poc.js";

const frame = (level: number, samples = 1600) => ({
  samples: new Int16Array(samples).fill(level),
  sampleRate: CAPTURE_RATE,
});

/** Speech, then the second of silence that ends the utterance and matches it. */
async function utter(gate: { push: (frame: unknown) => Promise<void> }) {
  await gate.push(frame(1000));
  await gate.push(frame(1000));
  await gate.push(frame(0, CAPTURE_RATE));
}

describe("the chain is the hub's own gate around a matcher", () => {
  test("the phrase opens the gate, and what follows is forwarded", async () => {
    const opened: { utterance: unknown }[] = [];
    const forwarded: unknown[] = [];
    const gate = createEarChain({
      wakeWord: alwaysWakeWord,
      events: {
        onOpen: (waking: { utterance: unknown }) => opened.push(waking),
        onIdle: () => {},
        onForward: (f: unknown) => forwarded.push(f),
      },
    });

    await utter(gate);

    expect(gate.isOpen).toBe(true);
    expect(opened).toHaveLength(1);
    // The utterance rides out with the opening: it is usually the question as
    // well as the phrase, and nothing here wrote down what it said.
    expect(opened[0].utterance).toMatchObject({ sampleRate: CAPTURE_RATE });

    // Open gate forwards; nothing was forwarded before it opened.
    expect(forwarded).toHaveLength(0);
    await gate.push(frame(1000));
    expect(forwarded).toHaveLength(1);
  });

  test("speech that is not the phrase never opens the gate", async () => {
    const opened: unknown[] = [];
    const gate = createEarChain({
      wakeWord: deafWakeWord,
      events: { onOpen: (w: unknown) => opened.push(w), onIdle: () => {}, onForward: () => {} },
    });

    await utter(gate);

    expect(gate.isOpen).toBe(false);
    expect(opened).toHaveLength(0);
  });

  test("a chain assembled without a wake word is deaf, not permissive", async () => {
    const opened: unknown[] = [];
    const gate = createEarChain({
      events: { onOpen: (w: unknown) => opened.push(w), onIdle: () => {}, onForward: () => {} },
    });

    await utter(gate);

    // Assembling a chain is not the same as knowing what to listen for.
    expect(gate.isOpen).toBe(false);
    expect(opened).toHaveLength(0);
  });
});

describe("the templates come from the hub, and their absence is silence", () => {
  const withBridge = async (bridge: unknown) => {
    const previous = (globalThis as { widget?: unknown }).widget;
    (globalThis as { widget?: unknown }).widget = bridge;
    try {
      return await loadWakeWord();
    } finally {
      (globalThis as { widget?: unknown }).widget = previous;
    }
  };

  test("no bridge at all leaves the widget deaf", async () => {
    expect(await withBridge(undefined)).toBe(deafWakeWord);
  });

  test("a hub that refuses leaves the widget deaf rather than trigger-happy", async () => {
    // The shell answers with an empty bank when the hub is unreachable, and a
    // detector holding nothing never matches anything.
    const detector = await withBridge({ wakeTemplates: async () => ({ templates: [] }) });
    expect(detector.heard(frame(1000, CAPTURE_RATE))).toBe(false);
  });

  test("a bridge that throws is the same closed direction", async () => {
    const detector = await withBridge({
      wakeTemplates: async () => {
        throw new Error("no hub");
      },
    });
    expect(detector.heard(frame(1000, CAPTURE_RATE))).toBe(false);
  });
});

describe("the plug: the lane's voice words, answered", () => {
  test("another client opening a voice session plugs these ears", () => {
    expect(plugDecision("voice_opened", false)).toBe("plug");
  });

  test("our own session's confirmation does not: the widget never self-plugs", () => {
    expect(plugDecision("voice_opened", true)).toBeNull();
  });

  test("a closed voice session always unplugs — listening is what should resume", () => {
    expect(plugDecision("voice_closed", false)).toBe("unplug");
    expect(plugDecision("voice_closed", true)).toBe("unplug");
  });

  test("every other word on the lane is not the ears' business", () => {
    for (const type of ["wake_opened", "caption", "thinking", "speaking", "idle", "answer", "progress"]) {
      expect(plugDecision(type, false)).toBeNull();
      expect(plugDecision(type, true)).toBeNull();
    }
  });
});
