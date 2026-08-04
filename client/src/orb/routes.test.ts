import { describe, expect, it, vi } from "vitest";

import { createWakeWordClassifier, type LocalEar, type VoiceActivityDetector } from "./ear.ts";
import type { RealtimeSession } from "./live.ts";
import { Mouth } from "./mouth.ts";
import { Orb, type OrbEvent } from "./orb.ts";
import { GESTURES, ORB_BASE_PATH, buildOrbApp, parseGesture } from "./routes.ts";
import { UtteranceBank, type ClipStore } from "./utterance-bank.ts";

function silentVad(): VoiceActivityDetector {
  return { isSpeech: () => false, reset: () => {} };
}

function fakeSession(): RealtimeSession {
  let muted = false;
  return {
    sendAudio: () => {},
    sendText: async () => {},
    sendFunctionResult: async () => {},
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

function emptyBank(): UtteranceBank {
  const store: ClipStore = { read: async () => undefined, write: async () => {}, list: async () => [] };
  return new UtteranceBank(store, () => 0);
}

function buildMount() {
  const ear: LocalEar = { languages: ["en"], transcribe: async () => "" };
  const listeners = new Set<(event: OrbEvent) => void>();
  const orb = new Orb({
    gate: { vad: silentVad(), ear, classifier: createWakeWordClassifier() },
    session: fakeSession(),
    bank: emptyBank(),
    mouth: new Mouth(),
    speaker: { play: async () => {} },
    brain: { ask: async () => "" },
    onEvent: (event) => {
      for (const listener of listeners) listener(event);
    },
  });
  const mount = {
    orb,
    subscribe: (listener: (event: OrbEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { app: buildOrbApp(mount), orb };
}

describe("the socket a face rides", () => {
  it("reports the orb's state and the ear's licensed languages", async () => {
    const { app } = buildMount();

    const response = await app.request(`${ORB_BASE_PATH}/status`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: true,
      state: "idle",
      gate: "idle",
      languages: ["en"],
    });
  });

  it("says why the orb is off instead of failing silently", async () => {
    const app = buildOrbApp({ reason: "The orb needs a Google account." });

    const status = await app.request(`${ORB_BASE_PATH}/status`);

    await expect(status.json()).resolves.toEqual({
      enabled: false,
      reason: "The orb needs a Google account.",
    });
  });

  it("refuses gestures when the orb is off, with the same reason", async () => {
    const app = buildOrbApp({ reason: "no key" });

    const response = await app.request(`${ORB_BASE_PATH}/gesture`, {
      method: "POST",
      body: JSON.stringify({ gesture: "toggle" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "no key" });
  });

  it("accepts a tap and toggles the gate", async () => {
    const { app, orb } = buildMount();

    const response = await app.request(`${ORB_BASE_PATH}/gesture`, {
      method: "POST",
      body: JSON.stringify({ gesture: "toggle" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(orb.gateState).toBe("open");
    await expect(response.json()).resolves.toEqual({ state: "listening", gate: "open" });
  });

  it("treats mute as stop listening, never as start", async () => {
    const { app, orb } = buildMount();
    orb.toggle();
    expect(orb.gateState).toBe("open");

    const post = (gesture: string) =>
      app.request(`${ORB_BASE_PATH}/gesture`, {
        method: "POST",
        body: JSON.stringify({ gesture }),
        headers: { "content-type": "application/json" },
      });

    await post("mute");
    expect(orb.gateState).toBe("idle");

    // Muting twice must not turn into unmuting.
    await post("mute");
    expect(orb.gateState).toBe("idle");
  });
});

describe("test_the_event_socket_carries_state_out_and_gestures_in_and_nothing_else", () => {
  it("names the gestures it accepts and refuses everything else", async () => {
    const { app, orb } = buildMount();

    for (const attempt of ["execute", "speak", "listen", "read_file", "", "toggle "]) {
      const response = await app.request(`${ORB_BASE_PATH}/gesture`, {
        method: "POST",
        body: JSON.stringify({ gesture: attempt }),
        headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(400);
    }

    expect(orb.gateState).toBe("idle");
  });

  it("keeps the vocabulary closed at the parser, not at the handler", () => {
    expect(GESTURES).toEqual(["toggle", "mute", "dismiss"]);
    expect(parseGesture("toggle")).toBe("toggle");
    expect(parseGesture("sendAudio")).toBeUndefined();
    expect(parseGesture({ gesture: "toggle" })).toBeUndefined();
    expect(parseGesture(undefined)).toBeUndefined();
  });

  it("refuses a malformed body rather than guessing at it", async () => {
    const { app } = buildMount();

    const response = await app.request(`${ORB_BASE_PATH}/gesture`, {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
  });

  it("streams state out as events, starting with where the orb is now", async () => {
    const { app, orb } = buildMount();
    const controller = new AbortController();

    const response = await app.request(`${ORB_BASE_PATH}/events`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"state":"idle"');

    orb.toggle();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain('"state":"listening"');

    controller.abort();
  });

  it("stops sending to a face that has gone away", async () => {
    const listeners = new Set<(event: OrbEvent) => void>();
    const subscribe = vi.fn((listener: (event: OrbEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const ear: LocalEar = { languages: ["en"], transcribe: async () => "" };
    const orb = new Orb({
      gate: { vad: silentVad(), ear, classifier: createWakeWordClassifier() },
      session: fakeSession(),
      bank: emptyBank(),
      mouth: new Mouth(),
      speaker: { play: async () => {} },
      brain: { ask: async () => "" },
      onEvent: (event) => {
        for (const listener of listeners) listener(event);
      },
    });
    const app = buildOrbApp({ orb, subscribe });
    const controller = new AbortController();

    const response = await app.request(`${ORB_BASE_PATH}/events`, { signal: controller.signal });
    await response.body!.getReader().read();
    expect(listeners.size).toBe(1);

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listeners.size).toBe(0);
  });
});
