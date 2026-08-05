import { describe, expect, it } from "vitest";

// The page's own module, imported exactly as the browser loads it. The seams it
// exports are DOM-free on purpose; `init()` is skipped because `document` is
// undefined here, which is the same guard the shipped file uses.
import { GESTURES, ORB_STATES, availability, interpret } from "../../public/orb.js";

describe("what the page will render", () => {
  it("renders each state the hub can report", () => {
    for (const state of ["idle", "listening", "thinking", "speaking"]) {
      expect(interpret({ type: "state", state })).toEqual({ kind: "state", state });
    }
  });

  it("ignores a state the hub never promised, rather than rendering it", () => {
    expect(interpret({ type: "state", state: "exploding" })).toBeNull();
    expect(interpret({ type: "state" })).toBeNull();
  });

  it("renders an unattributed caption — the lane's word carries no speaker", () => {
    expect(interpret({ type: "caption", text: "hello" })).toEqual({
      kind: "caption",
      text: "hello",
    });
  });

  it("drops an empty caption instead of clearing the line with nothing", () => {
    expect(interpret({ type: "caption", text: "   " })).toBeNull();
    expect(interpret({ type: "caption" })).toBeNull();
  });

  it("has no rendering for mood — sentiment never reaches the deaf hub", () => {
    expect(interpret({ type: "mood", mood: "excited" })).toBeNull();
  });

  it("drops anything that is not an event at all", () => {
    for (const junk of [null, undefined, "state", 42, {}, { type: "execute" }]) {
      expect(interpret(junk)).toBeNull();
    }
  });
});

describe("test_a_skin_cannot_widen_the_socket_vocabulary", () => {
  it("names the same closed gesture set the hub accepts", () => {
    expect(GESTURES).toEqual(["toggle", "mute", "dismiss"]);
  });

  it("names the same closed state set the hub emits", () => {
    expect(ORB_STATES).toEqual(["idle", "listening", "thinking", "speaking"]);
  });
});

describe("what the page does when there is no credential", () => {
  it("is unusable and carries the hub's own reason", () => {
    const verdict = availability({ enabled: false, reason: "The orb needs a Google account." });

    expect(verdict).toEqual({ usable: false, reason: "The orb needs a Google account." });
  });

  it("still refuses honestly when the probe itself failed", () => {
    expect(availability(undefined).usable).toBe(false);
    expect(availability(undefined).reason).toMatch(/unavailable/i);
  });

  it("comes up in the state the hub reported", () => {
    expect(availability({ enabled: true, state: "idle" })).toEqual({
      usable: true,
      state: "idle",
    });
  });

  it("renders the status route's coarse 'talking' as the listening state", () => {
    expect(availability({ enabled: true, state: "talking", mouths: 1 })).toEqual({
      usable: true,
      state: "listening",
    });
  });

  it("falls back to idle rather than trusting a state it does not know", () => {
    expect(availability({ enabled: true, state: "melting" })).toEqual({
      usable: true,
      state: "idle",
    });
  });
});
