import { describe, expect, it } from "vitest";

import type { StateEvent } from "../events/types.ts";
import { createLaneFaceSource } from "./face-source.ts";

/**
 * The joint, pointed the other way.
 *
 * The old suite here proved a hub-side orb's events reached the faces. That
 * orb is gone; what these tests pin instead is that the face events are
 * derived honestly from the lane's own traffic — a session opening, an ask in
 * flight, an answer going out — and that captions are delivered exactly once
 * to each kind of face: the socket relays them to WebSocket faces itself, so
 * only the SSE-facing subscription hears them here.
 */

function collect(): { events: StateEvent[]; handler: (event: StateEvent) => void } {
  const events: StateEvent[] = [];
  return { events, handler: (event) => events.push(event) };
}

describe("what the lane's traffic means for a face", () => {
  it("a first voice session opening is the wake — a conversation is live somewhere", () => {
    const faces = createLaneFaceSource();
    const lane = collect();
    faces.source.subscribe(lane.handler);

    faces.observer.voiceCount(1);

    expect(lane.events).toEqual([{ type: "wake_opened" }]);
  });

  it("a second mouth joining says nothing — the wake already happened", () => {
    const faces = createLaneFaceSource();
    const lane = collect();
    faces.source.subscribe(lane.handler);

    faces.observer.voiceCount(1);
    faces.observer.voiceCount(2);

    expect(lane.events).toEqual([{ type: "wake_opened" }]);
  });

  it("only the last mouth closing puts the face to rest", () => {
    const faces = createLaneFaceSource();
    const lane = collect();
    faces.source.subscribe(lane.handler);

    faces.observer.voiceCount(2);
    faces.observer.voiceCount(1);
    expect(lane.events).toEqual([{ type: "wake_opened" }]);

    faces.observer.voiceCount(0);
    expect(lane.events).toEqual([{ type: "wake_opened" }, { type: "idle" }]);
  });

  it("an ask in flight is thinking; an answer going out is speaking", () => {
    const faces = createLaneFaceSource();
    const lane = collect();
    faces.source.subscribe(lane.handler);

    faces.observer.askStarted();
    faces.observer.answerDelivered();

    expect(lane.events).toEqual([{ type: "thinking" }, { type: "speaking" }]);
  });

  it("counts the open mouths for the status route", () => {
    const faces = createLaneFaceSource();

    expect(faces.mouths()).toBe(0);
    faces.observer.voiceCount(2);
    expect(faces.mouths()).toBe(2);
    faces.observer.voiceCount(0);
    expect(faces.mouths()).toBe(0);
  });
});

describe("captions are said once to each kind of face", () => {
  it("the SSE-facing subscription hears captions; the lane-facing source does not", () => {
    const faces = createLaneFaceSource();
    const lane = collect();
    const sse = collect();
    faces.source.subscribe(lane.handler);
    faces.subscribeFace(sse.handler);

    faces.observer.caption("the words that crossed the lane");

    // The socket already relayed this caption to every WebSocket face itself.
    // Repeating it through the lane source would say everything twice.
    expect(lane.events).toEqual([]);
    expect(sse.events).toEqual([{ type: "caption", text: "the words that crossed the lane" }]);
  });

  it("derived states reach both kinds of face", () => {
    const faces = createLaneFaceSource();
    const lane = collect();
    const sse = collect();
    faces.source.subscribe(lane.handler);
    faces.subscribeFace(sse.handler);

    faces.observer.voiceCount(1);
    faces.observer.askStarted();

    expect(lane.events).toEqual([{ type: "wake_opened" }, { type: "thinking" }]);
    expect(sse.events).toEqual([{ type: "wake_opened" }, { type: "thinking" }]);
  });

  it("an unsubscribed face hears nothing more", () => {
    const faces = createLaneFaceSource();
    const sse = collect();
    const unsubscribe = faces.subscribeFace(sse.handler);

    faces.observer.voiceCount(1);
    unsubscribe();
    faces.observer.caption("said after the face left");
    faces.observer.voiceCount(0);

    expect(sse.events).toEqual([{ type: "wake_opened" }]);
  });
});
