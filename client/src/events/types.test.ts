import { expect, test, describe } from "vitest";

import {
  GESTURE_TYPES,
  STATE_EVENT_TYPES,
  isGesture,
  isStateEvent,
  parseGesture,
  parseStateEvent,
} from "./types.ts";

/**
 * The vocabulary is the security boundary, so it is tested as one.
 *
 * A skin is a display asset reading the same event stream. The claim the issue
 * makes is that a skin can never widen the socket's vocabulary — no matter what
 * it sends, it gets the capabilities the hub already decided to offer and not
 * one word more. Below, a skin is played by whatever a hostile or careless
 * author could put on the wire.
 */

test("test_a_skin_cannot_widen_the_socket_vocabulary", () => {
  // A word the hub never agreed to carry. This is the whole attack: invent a
  // verb, hope something downstream reads it.
  expect(isGesture({ type: "record_microphone" })).toBe(false);
  expect(isGesture({ type: "run_tool", name: "execute_command" })).toBe(false);
  expect(isGesture({ type: "read_file", path: "/etc/passwd" })).toBe(false);
  expect(isStateEvent({ type: "audio_frame", pcm: [0, 1, 2] })).toBe(false);
  expect(isStateEvent({ type: "credential", value: "sk-live" })).toBe(false);

  // A real word carrying a stowaway field. Trimming the extra key and
  // admitting the rest would mean the hub carries a payload it never agreed
  // to, so the whole message is refused instead.
  expect(isGesture({ type: "mute", alsoRunShell: "rm -rf /" })).toBe(false);
  expect(isGesture({ type: "dismiss", exfiltrate: "secret" })).toBe(false);
  expect(isGesture({ type: "drag", x: 1, y: 2, audio: "base64..." })).toBe(false);
  expect(isStateEvent({ type: "idle", audio: "base64..." })).toBe(false);
  expect(isStateEvent({ type: "caption", text: "hi", tool: "shell" })).toBe(false);
  // A scout carries a rectangle and nothing about what is in it. A name, a
  // role, or a value smuggled alongside would make the pointing word a
  // reading word.
  expect(
    isStateEvent({ type: "touching", id: "call-1", x: 0, y: 0, width: 8, height: 8, name: "Password" }),
  ).toBe(false);
  expect(isStateEvent({ type: "released", id: "call-1", value: "hunter2" })).toBe(false);

  // Prototype pollution dressed as a gesture: `type` arriving from the
  // prototype chain rather than the object's own keys.
  const inherited = Object.create({ type: "mute" }) as unknown;
  expect(isGesture(inherited)).toBe(false);

  // The two vocabularies are separate. A face may not announce state, and the
  // hub's words are not gestures a face can replay back.
  for (const type of STATE_EVENT_TYPES) {
    if (type === "caption") continue;
    expect(isGesture({ type })).toBe(false);
  }
  for (const type of GESTURE_TYPES) {
    if (type === "drag") continue;
    expect(isStateEvent({ type })).toBe(false);
  }

  // Everything the hub does offer still passes, or the guard would be closed
  // by being broken rather than by being strict.
  expect(isGesture({ type: "mute" })).toBe(true);
  expect(isGesture({ type: "dismiss" })).toBe(true);
  expect(isGesture({ type: "drag", x: 12, y: 40 })).toBe(true);
  expect(isStateEvent({ type: "wake_opened" })).toBe(true);
  expect(isStateEvent({ type: "caption", text: "hello" })).toBe(true);
  expect(isStateEvent({ type: "thinking" })).toBe(true);
  expect(isStateEvent({ type: "speaking" })).toBe(true);
  expect(isStateEvent({ type: "idle" })).toBe(true);
  expect(isStateEvent({ type: "touching", id: "call-1", x: 12, y: 40, width: 96, height: 32 })).toBe(
    true,
  );
  expect(isStateEvent({ type: "released", id: "call-1" })).toBe(true);
});

describe("pointing at what is being touched", () => {
  test("refuses a rectangle that is not a place a scout could go", () => {
    const at = (rect: Record<string, unknown>) => ({ type: "touching", id: "call-1", ...rect });
    // No extent is not a place. An element reported at zero size is off-screen
    // or not laid out, and an orb drawn over it would be an orb drawn over
    // nothing while claiming otherwise.
    expect(isStateEvent(at({ x: 0, y: 0, width: 0, height: 10 }))).toBe(false);
    expect(isStateEvent(at({ x: 0, y: 0, width: 10, height: 0 }))).toBe(false);
    expect(isStateEvent(at({ x: 0, y: 0, width: -10, height: 10 }))).toBe(false);
    expect(isStateEvent(at({ x: Number.NaN, y: 0, width: 10, height: 10 }))).toBe(false);
    expect(isStateEvent(at({ x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 }))).toBe(false);
    expect(isStateEvent(at({ x: "12", y: "40", width: 10, height: 10 }))).toBe(false);
  });

  test("admits a rectangle on a monitor left of the primary one", () => {
    // A second screen to the left has negative screen coordinates, and a face
    // that refused them would refuse half of a two-monitor desk.
    expect(
      isStateEvent({ type: "touching", id: "call-1", x: -1920, y: -200, width: 40, height: 40 }),
    ).toBe(true);
  });

  test("refuses a word that names no operation to point at or let go of", () => {
    expect(isStateEvent({ type: "touching", id: "", x: 0, y: 0, width: 8, height: 8 })).toBe(false);
    expect(isStateEvent({ type: "touching", id: 7, x: 0, y: 0, width: 8, height: 8 })).toBe(false);
    expect(isStateEvent({ type: "released" })).toBe(false);
    expect(isStateEvent({ type: "released", id: "" })).toBe(false);
  });
});

describe("the guards", () => {
  test("refuse anything that is not a plain object", () => {
    for (const value of [null, undefined, 42, "mute", true, [], [{ type: "mute" }], () => {}]) {
      expect(isGesture(value)).toBe(false);
      expect(isStateEvent(value)).toBe(false);
    }
  });

  test("refuse a known word that is missing the fields it promised", () => {
    expect(isStateEvent({ type: "caption" })).toBe(false);
    expect(isGesture({ type: "drag" })).toBe(false);
    expect(isGesture({ type: "drag", x: 1 })).toBe(false);
  });

  test("refuse a caption whose text is not text", () => {
    expect(isStateEvent({ type: "caption", text: 42 })).toBe(false);
    expect(isStateEvent({ type: "caption", text: null })).toBe(false);
    expect(isStateEvent({ type: "caption", text: ["hi"] })).toBe(false);
  });

  test("admit an empty caption, which is a real thing an ear produces", () => {
    expect(isStateEvent({ type: "caption", text: "" })).toBe(true);
  });

  test("refuse a drag to a coordinate that is not a place", () => {
    expect(isGesture({ type: "drag", x: Number.NaN, y: 0 })).toBe(false);
    expect(isGesture({ type: "drag", x: 0, y: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isGesture({ type: "drag", x: "10", y: "20" })).toBe(false);
  });

  test("admit a drag to a negative coordinate, which a multi-monitor desk has", () => {
    expect(isGesture({ type: "drag", x: -1920, y: -12 })).toBe(true);
  });
});

describe("parsing off the wire", () => {
  test("returns the message when the frame is a word the hub knows", () => {
    expect(parseGesture('{"type":"mute"}')).toEqual({ type: "mute" });
    expect(parseStateEvent('{"type":"caption","text":"hi"}')).toEqual({
      type: "caption",
      text: "hi",
    });
  });

  test("treats malformed json and an unknown word as the same nothing", () => {
    // Both come back undefined on purpose: a caller that could tell "your JSON
    // was bad" from "that verb does not exist" would learn which of its
    // guesses parsed, and could walk the vocabulary that way.
    expect(parseGesture("not json at all")).toBeUndefined();
    expect(parseGesture("{")).toBeUndefined();
    expect(parseGesture('{"type":"record_microphone"}')).toBeUndefined();
    expect(parseStateEvent('{"type":"audio_frame"}')).toBeUndefined();
  });

  test("refuses a json frame that is a bare primitive", () => {
    expect(parseGesture('"mute"')).toBeUndefined();
    expect(parseGesture("null")).toBeUndefined();
  });
});
