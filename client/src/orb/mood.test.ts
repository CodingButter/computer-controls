/**
 * The orb wears the conversation's mood (#106).
 *
 * Two acceptance tests live here, and the second is the one that matters. A
 * sentiment label is a guess about how a person feels, made without being asked
 * and impossible for them to correct — the most private thing this product
 * derives. The design answer is that it is never written down: it rides the
 * classifier pass that already runs, becomes a colour, and ends.
 *
 * "Never persisted" is easy to claim and easy to break by accident six months
 * later, so it is tested here against the real objects rather than asserted in
 * a comment: the real gate, the real classifier, a session that records
 * everything it is handed, and a brain that records everything it is asked.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  createWakeWordClassifier,
  readSentiment,
  SENTIMENTS,
  type AudioFrame,
  type LocalEar,
  type Sentiment,
  type VoiceActivityDetector,
} from "./ear.ts";
import { alwaysWakeWord } from "./ear-poc.ts";
import type { RealtimeSession } from "./live.ts";
import { Mouth } from "./mouth.ts";
import { Orb, type OrbEvent, type Speaker } from "./orb.ts";
import { UtteranceBank, type ClipStore } from "./utterance-bank.ts";
import { moodToColor } from "../../public/orb-webgl.js";
import { interpret, ORB_MOODS } from "../../public/orb.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SAMPLE_RATE = 16_000;

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

/** A session that keeps everything it was ever handed, so a test can search it. */
function recordingSession(): RealtimeSession & { audio: Uint8Array[]; texts: string[]; results: string[] } {
  let muted = false;
  const audio: Uint8Array[] = [];
  const texts: string[] = [];
  const results: string[] = [];
  return {
    audio,
    texts,
    results,
    sendAudio: (chunk) => audio.push(chunk),
    sendText: async (text) => {
      texts.push(text);
    },
    sendFunctionResult: async (_id, result) => {
      results.push(result);
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

function build(transcript: string) {
  const vad = controllableVad();
  const ear: LocalEar = { languages: ["en"], transcribe: async () => transcript };
  const session = recordingSession();
  const store: ClipStore = { read: async () => undefined, write: async () => {}, list: async () => [] };
  const speaker: Speaker = { play: async () => {} };
  const ask = vi.fn(async (request: string) => `did: ${request}`);
  const events: OrbEvent[] = [];
  const orb = new Orb({
    gate: { vad, ear, classifier: createWakeWordClassifier(), wakeWord: alwaysWakeWord },
    session,
    bank: new UtteranceBank(store, () => 0),
    mouth: new Mouth(),
    speaker,
    brain: { ask },
    onEvent: (event) => events.push(event),
  });
  return { orb, session, vad, ask, events };
}

async function say(orb: Orb, vad: { speaking: boolean }, speech = 10, silence = 8) {
  vad.speaking = true;
  for (let i = 0; i < speech; i += 1) await orb.push(frame());
  vad.speaking = false;
  for (let i = 0; i < silence; i += 1) await orb.push(frame());
}

const moods = (events: OrbEvent[]): Sentiment[] =>
  events.flatMap((event) => (event.type === "mood" ? [event.mood] : []));

// ---------------------------------------------------------------------------

describe("test_the_orb_color_follows_the_sentiment_label", () => {
  it("reads frustration, excitement and calm from what was said after the wake word", () => {
    const classify = createWakeWordClassifier().classify;

    expect(classify("mastra it's still not working").sentiment).toBe("frustrated");
    expect(classify("mastra that worked, amazing").sentiment).toBe("excited");
    expect(classify("mastra no rush, what's the weather").sentiment).toBe("calm");
    expect(classify("mastra open the browser").sentiment).toBe("neutral");
  });

  it("carries the label from the utterance to a mood event on the way out", async () => {
    const { orb, vad, events } = build("mastra this is still broken");

    await say(orb, vad);

    expect(moods(events)).toContain("frustrated");
  });

  it("maps every label the classifier can produce to a distinct color", () => {
    const seen = new Map<string, Sentiment>();
    for (const sentiment of SENTIMENTS) {
      const key = moodToColor(sentiment).join(",");
      expect(seen.has(key)).toBe(false);
      seen.set(key, sentiment);
    }
    expect(seen.size).toBe(SENTIMENTS.length);
  });

  it("uses the colors the issue asked for: red frustrated, green excited, blue calm", () => {
    const [fr, fg, fb] = moodToColor("frustrated");
    expect(fr).toBeGreaterThan(0.7);
    expect(fr).toBeGreaterThan(fg + 0.4);
    expect(fr).toBeGreaterThan(fb + 0.4);

    const [er, eg, eb] = moodToColor("excited");
    expect(eg).toBeGreaterThan(er + 0.3);
    expect(eg).toBeGreaterThan(eb + 0.3);

    const [cr, cg, cb] = moodToColor("calm");
    expect(cb).toBeGreaterThan(cr + 0.3);
    expect(cb).toBeGreaterThan(cg + 0.3);
  });

  it("returns to the resting color when the conversation goes quiet", async () => {
    const { orb, vad, events } = build("mastra this is broken again");

    await say(orb, vad);
    expect(moods(events)).toContain("frustrated");

    orb.closeGate();

    expect(moods(events).at(-1)).toBe("neutral");
  });

  it("hands the page a mood it can render, and refuses one it cannot", () => {
    expect(interpret({ type: "mood", mood: "frustrated" })).toEqual({
      kind: "mood",
      mood: "frustrated",
    });
    // A label the hub never promised renders as nothing rather than as a guess.
    expect(interpret({ type: "mood", mood: "despondent" })).toBeNull();
    expect(interpret({ type: "mood" })).toBeNull();
  });

  it("agrees with the page about which moods exist", () => {
    expect([...ORB_MOODS].sort()).toEqual([...SENTIMENTS].sort());
  });

  it("eases the color over seconds rather than snapping, at a rate set per second", () => {
    const webgl = readFileSync(resolve(__dirname, "../../public/orb-webgl.js"), "utf-8");

    // The rate must be multiplied by the frame delta. A fixed per-frame
    // fraction would tie the speed of an emotional transition to the refresh
    // rate of the monitor it happens to be drawn on.
    expect(webgl).toMatch(/moodStep\s*=\s*Math\.min\(1,\s*dt\s*\*\s*MOOD_EASE_PER_SECOND\)/);
    expect(webgl).not.toMatch(/uColor\.value[\s\S]{0,80}\*\s*0\.05/);
  });
});

// ---------------------------------------------------------------------------

describe("test_sentiment_is_never_persisted_or_sent_off_the_machine", () => {
  it("sends no sentiment label to the realtime provider", async () => {
    const { orb, session, vad } = build("mastra this is still broken, seriously");

    await say(orb, vad);
    orb.realtimeEvents.onFunctionCall({
      id: "call-1",
      name: "ask_the_hub",
      args: { request: "fix it" },
    });
    await new Promise((r) => setTimeout(r, 0));

    // Everything the provider was handed, as text. Audio is the person's own
    // voice and is out of scope; what must not appear is our reading of it.
    const written = [...session.texts, ...session.results].join(" ").toLowerCase();
    for (const sentiment of SENTIMENTS) {
      expect(written).not.toContain(sentiment);
    }
  });

  it("sends no sentiment label to the agent, whose thread is written to disk", async () => {
    const { orb, vad, ask } = build("mastra this is broken again, seriously");

    await say(orb, vad);
    orb.realtimeEvents.onFunctionCall({
      id: "call-1",
      name: "ask_the_hub",
      args: { request: "open the browser" },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(ask).toHaveBeenCalledWith("open the browser", expect.any(Function));
    for (const call of ask.mock.calls) {
      for (const sentiment of SENTIMENTS) {
        expect(call[0].toLowerCase()).not.toContain(sentiment);
      }
    }
  });

  it("keeps no mood on the orb, so there is nothing to read back or replay", async () => {
    const { orb, vad } = build("mastra this is still broken");

    await say(orb, vad);

    // The state survives a wake because a face that connects late needs it.
    // The mood deliberately does not: not as a property, not on the status
    // the routes report. A field holding it would be a record of it.
    const readable = JSON.stringify({ ...orb, state: orb.state, gate: orb.gateState });
    for (const sentiment of SENTIMENTS.filter((s) => s !== "neutral")) {
      expect(readable.toLowerCase()).not.toContain(sentiment);
    }
    expect(Object.keys(orb)).not.toContain("mood");
    expect((orb as unknown as { mood?: unknown }).mood).toBeUndefined();
  });

  it("never asks about somebody who was not talking to us", () => {
    const classify = createWakeWordClassifier().classify;

    // No wake word: the machine was not addressed, so the mood of whoever is in
    // the room is not read at all. The gate drops this before it reaches the
    // orb, and the label is resting rather than a guess.
    const overheard = classify("this is still broken and I am furious about it");
    expect(overheard.addressed).toBe(false);
    expect(overheard.sentiment).toBe("neutral");
  });

  it("reads the mood locally, from text the ear already produced", () => {
    // readSentiment is a pure function of a string. It cannot reach a network
    // even if a future edit wanted it to, which is the cheapest possible form
    // of "never leaves the machine".
    expect(readSentiment("it's still not working")).toBe("frustrated");
    expect(readSentiment("")).toBe("neutral");
    expect(readSentiment.length).toBe(1);
  });

  it("writes no mood into the captions or the drawer the page keeps", async () => {
    const { orb, vad, events } = build("mastra this is still broken");

    await say(orb, vad);

    const captions = events.flatMap((e) => (e.type === "caption" ? [e.text] : []));
    expect(captions).toEqual(["mastra this is still broken"]);
    // The transcript is the person's own words and is theirs to see. Our
    // reading of their tone is not in it.
    for (const caption of captions) {
      expect(caption.toLowerCase()).not.toContain("frustrated");
    }

    const page = readFileSync(resolve(__dirname, "../../public/orb.js"), "utf-8");
    // The mood reaches the shader and stops. If it were ever appended to the
    // log the drawer keeps, this is the line that would catch it.
    expect(page).toMatch(/kind === "mood"[\s\S]{0,400}?setMood\(instruction\.mood\)/);
    expect(page).not.toMatch(/appendTurn\([^)]*mood/);
    expect(page).not.toMatch(/caption\.textContent\s*=\s*[^;]*mood/);
  });

  it("puts no mood on the wire the widget reads, which is a different vocabulary", async () => {
    const types = readFileSync(resolve(__dirname, "../events/types.ts"), "utf-8");

    // #107's socket is a closed union and adding a word to it is a deliberate
    // act. The orb page gets the mood over its own stream; the desktop widget
    // was not given a reason to know how somebody sounded.
    expect(types).not.toMatch(/mood|sentiment|frustrated/i);
  });
});
