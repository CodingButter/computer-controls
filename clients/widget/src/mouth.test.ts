// The mouth's decisions without a browser, and its disciplines by source scan
// — the same split the orb page's mouth is held to, applied to the copy.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { bytesFromFrame, floatFromPcm16, frameForVoice, interpretLaneFrame, openMouth } from "./mouth.js";
import { ANSWER_PREFIX, ANSWER_SUFFIX, PROGRESS_PREFIX, PROGRESS_SUFFIX } from "./vendor/live/live.js";

const mouthSource = readFileSync(new URL("./mouth.js", import.meta.url), "utf8");
const rendererSource = readFileSync(new URL("./renderer.js", import.meta.url), "utf8");

describe("what a lane frame means to this mouth", () => {
  test("progress and answer with exactly {type,id,text} are meanings", () => {
    expect(interpretLaneFrame({ type: "answer", id: "a1", text: "done" })).toEqual({
      kind: "answer",
      id: "a1",
      text: "done",
    });
    expect(interpretLaneFrame({ type: "progress", id: "a1", text: "working" })).toEqual({
      kind: "progress",
      id: "a1",
      text: "working",
    });
  });

  test("a stowaway field, a missing field, or a wrong type is noise", () => {
    expect(interpretLaneFrame({ type: "answer", id: "a1", text: "done", extra: true })).toBeNull();
    expect(interpretLaneFrame({ type: "answer", id: "a1" })).toBeNull();
    expect(interpretLaneFrame({ type: "answer", id: 7, text: "done" })).toBeNull();
    expect(interpretLaneFrame({ type: "caption", id: "a1", text: "x" })).toBeNull();
    expect(interpretLaneFrame("answer")).toBeNull();
    expect(interpretLaneFrame(null)).toBeNull();
  });
});

describe("how a reply is framed for the voice", () => {
  test("answers and progress wear their own prefixes", () => {
    expect(frameForVoice("answer", "it is Tuesday")).toBe(ANSWER_PREFIX + "it is Tuesday" + ANSWER_SUFFIX);
    expect(frameForVoice("progress", "halfway")).toBe(PROGRESS_PREFIX + "halfway" + PROGRESS_SUFFIX);
  });
});

describe("the audio arithmetic", () => {
  test("a gate frame's bytes are the samples' own octets, little-endian", () => {
    const frame = { samples: new Int16Array([0x1234, -2]), sampleRate: 16000 };
    const bytes = bytesFromFrame(frame);
    expect(Array.from(bytes)).toEqual([0x34, 0x12, 0xfe, 0xff]);
    // A view, not a copy: the byte length is exactly twice the sample count.
    expect(bytes.buffer).toBe(frame.samples.buffer);
  });

  test("pcm16 becomes floats in [-1, 1)", () => {
    const bytes = new Uint8Array(new Int16Array([0, 0x4000, -0x8000]).buffer);
    expect(Array.from(floatFromPcm16(bytes))).toEqual([0, 0.5, -1]);
  });
});

describe("the mouth's refusals, before any audio machinery exists", () => {
  test("a dead lane keeps the mouth shut: no voice_open, no mint, nothing", async () => {
    const sent: object[] = [];
    let minted = 0;
    await expect(
      openMouth({
        lane: { send: (frame: object) => sent.push(frame), isOpen: () => false },
        mintToken: async () => {
          minted += 1;
          return { token: "t" };
        },
        opening: null,
      }),
    ).rejects.toThrow("The hub's event lane is down, so the mouth stayed shut.");
    expect(sent).toEqual([]);
    expect(minted).toBe(0);
  });

  test("a refused mint is the hub's sentence verbatim — and voice_close is said on the way out", async () => {
    const sent: Array<{ type?: string }> = [];
    await expect(
      openMouth({
        lane: { send: (frame: object) => sent.push(frame), isOpen: () => true },
        mintToken: async () => ({ error: "No Google account is connected, so the orb has no voice." }),
        opening: null,
      }),
    ).rejects.toThrow("No Google account is connected, so the orb has no voice.");
    // voice_open was said before the mint — that is the design's order — so
    // the failed open must be walked back, or the widget deafens every other
    // ear on the lane forever.
    expect(sent.map((frame) => frame.type)).toEqual(["voice_open", "voice_close"]);
  });
});

describe("the disciplines, pinned in the source", () => {
  test("the mouth holds no microphone: the ears own it, and this file never asks", () => {
    expect(mouthSource).not.toContain("getUserMedia");
    expect(mouthSource).not.toContain("mediaDevices");
  });

  test("the token rides the bridge, never an HTTP client in this file", () => {
    expect(mouthSource).not.toContain("fetch(");
    expect(mouthSource).not.toContain("XMLHttpRequest");
    expect(rendererSource).toContain("window.widget.mintToken()");
  });

  test("no credential-shaped string anywhere near the mouth", () => {
    for (const source of [mouthSource, rendererSource]) {
      expect(source).not.toContain("apiKey: process");
      expect(source).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
      expect(source).not.toContain("x-goog-api-key");
    }
    // The one apiKey the mouth states is the empty string the token dial requires.
    expect(mouthSource).toContain('apiKey: ""');
  });

  test("a stop_listening call ends the turn instead of becoming an empty ask", () => {
    // The widget dials the same hub-minted token the orb page does, so its
    // model has the same two tools. Without a branch, stop_listening would
    // fall through to the ask path and dispatch a request with no words in
    // it — and the session the user asked to end would stay open.
    const handler = mouthSource.slice(mouthSource.indexOf("onFunctionCall: (call)"));
    const branch = handler.indexOf('call.name === "stop_listening"');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(handler.indexOf("sendFunctionResult(call.id, DISPATCH_ACK)"));
    expect(handler.slice(branch, handler.indexOf("onRefusal"))).toContain("onDismiss?.()");
    // The renderer owns the face's state and the mouth reference, so the
    // dismissal is routed through it rather than closing the mouth behind
    // its back and leaving a listening face with no session. And it puts the
    // face away: being asked to go is the primary way this widget leaves the
    // screen, ahead of any timer.
    const dismissal = rendererSource.slice(rendererSource.indexOf("onDismiss: () =>"));
    expect(dismissal).toContain("closeMouth()");
    expect(dismissal.slice(0, 400)).toContain('applyGesture(state, { type: "dismiss" })');
  });

  test("the lane is checked before the acknowledgement that promises an answer", () => {
    // Code positions, not comment positions: the pin compares the guard
    // statement against the send that makes the promise.
    const handler = mouthSource.slice(mouthSource.indexOf("onFunctionCall: (call)"));
    expect(handler.indexOf("if (!lane.isOpen())")).toBeGreaterThan(-1);
    expect(handler.indexOf("if (!lane.isOpen())")).toBeLessThan(
      handler.indexOf("sendFunctionResult(call.id, DISPATCH_ACK)"),
    );
  });

  test("voice_open is said before the token is minted, and the mouth borrows the lane rather than closing it", () => {
    expect(mouthSource.indexOf('lane.send({ type: "voice_open" })')).toBeGreaterThan(-1);
    expect(mouthSource.indexOf('lane.send({ type: "voice_open" })')).toBeLessThan(
      mouthSource.indexOf("await mintToken()"),
    );
    expect(mouthSource).not.toContain("lane.close");
  });

  test("only this mouth's own asks are spoken — the pending set is the filter", () => {
    const deliver = mouthSource.slice(mouthSource.indexOf("deliver(frame)"));
    expect(deliver).toContain("pendingAsks.has(meaning.id)");
  });

  test("a lane word never barges the model mid-speech — it queues until playback drains", () => {
    // Sending text into a live session while audio is playing is a barge:
    // Gemini abandons the sentence it was saying. Live QA heard answers cut
    // off by their own progress updates. The deliver path must check the
    // playing set before sendText, and the drain path must flush the queue.
    const deliver = mouthSource.slice(mouthSource.indexOf("deliver(frame)"));
    expect(deliver.indexOf("playing.size > 0")).toBeGreaterThan(-1);
    expect(deliver.indexOf("playing.size > 0")).toBeLessThan(deliver.indexOf("session.sendText"));
    expect(mouthSource).toContain("if (playing.size === 0) flushHeldWords()");
    // An answer purges the queued progress it outran.
    expect(deliver).toContain('heldWords[i].kind === "progress"');
  });
});
