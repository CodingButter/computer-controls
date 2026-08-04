import { describe, expect, test } from "vitest";

// Imported the way the widget's renderer imports it: the shipped module, not a
// typed twin of it. If this ever resolves to something the shell would not
// load, these tests stop being about the widget that runs.
import {
  INITIAL_STATE,
  OFFERED_GESTURES,
  UNDERSTOOD_EVENTS,
  applyGesture,
  reduce,
} from "./state-machine.js";
import { GESTURE_TYPES, STATE_EVENT_TYPES } from "../../../client/src/events/types.ts";

/** Play a whole conversation through the reducer. */
const run = (events: { type: string; text?: string }[], from = INITIAL_STATE) =>
  events.reduce(reduce, from);

test("test_the_widget_appears_on_wake_and_fades_on_idle", () => {
  // Before anything is said there is nothing to look at. A widget that drew
  // itself on an empty desk would be a taskbar, not a presence.
  expect(INITIAL_STATE.presence).toBe("hidden");

  // The gate opens: the face materialises, listening.
  const woken = reduce(INITIAL_STATE, { type: "wake_opened" });
  expect(woken.presence).toBe("visible");
  expect(woken.activity).toBe("listening");

  // It stays through the whole turn, following what the hub is doing.
  const heard = reduce(woken, { type: "caption", text: "what is on my calendar" });
  expect(heard.presence).toBe("visible");
  const thinking = reduce(heard, { type: "thinking" });
  expect(thinking).toMatchObject({ presence: "visible", activity: "thinking" });
  const speaking = reduce(thinking, { type: "speaking" });
  expect(speaking).toMatchObject({ presence: "visible", activity: "speaking" });

  // The turn ends and the face goes away again, taking the caption with it.
  const idle = reduce(speaking, { type: "idle" });
  expect(idle.presence).toBe("hidden");
  expect(idle.caption).toBe("");

  // And the next wake brings it back, so this is a rhythm rather than a
  // one-time appearance.
  expect(reduce(idle, { type: "wake_opened" }).presence).toBe("visible");
});

describe("presence", () => {
  test("shows up for a caption it did not see the wake for", () => {
    // A widget launched mid-sentence, or a socket that reconnected, gets a
    // caption with no wake in front of it. Captioning an invisible orb would
    // be worse than arriving late.
    const state = reduce(INITIAL_STATE, { type: "caption", text: "already talking" });
    expect(state.presence).toBe("visible");
    expect(state.caption).toBe("already talking");
  });

  test("clears the last turn's words when a new one opens", () => {
    const stale = run([
      { type: "wake_opened" },
      { type: "caption", text: "yesterday's question" },
      { type: "idle" },
    ]);
    expect(reduce(stale, { type: "wake_opened" }).caption).toBe("");
  });

  test("keeps the user's settings across a turn ending", () => {
    // Mute and position are the user's, not the conversation's. Idle ends a
    // conversation; it does not un-mute a widget somebody muted.
    let state = applyGesture(INITIAL_STATE, { type: "mute" });
    state = applyGesture(state, { type: "drag", x: 300, y: 40 });
    state = run([{ type: "wake_opened" }, { type: "idle" }], state);

    expect(state.muted).toBe(true);
    expect(state.position).toEqual({ x: 300, y: 40 });
  });

  test("ignores a word it has never heard of instead of failing", () => {
    // A hub that learns a new word before this widget does should get a widget
    // that shrugs, not one that throws inside a socket handler and leaves a
    // window open with nothing driving it.
    const visible = reduce(INITIAL_STATE, { type: "wake_opened" });
    expect(reduce(visible, { type: "a_word_from_a_later_version" })).toEqual(visible);
  });
});

describe("gestures", () => {
  test("mute is a toggle the widget draws and the hub enforces", () => {
    const muted = applyGesture(INITIAL_STATE, { type: "mute" });
    expect(muted.muted).toBe(true);
    expect(applyGesture(muted, { type: "mute" }).muted).toBe(false);
  });

  test("dismiss hides this turn's face without ending the conversation", () => {
    const speaking = run([{ type: "wake_opened" }, { type: "speaking" }]);
    const dismissed = applyGesture(speaking, { type: "dismiss" });

    expect(dismissed.presence).toBe("hidden");
    // The ears are the hub's, so dismissing a face cannot mute them, and the
    // next thing the hub says brings the widget back.
    expect(dismissed.muted).toBe(false);
    expect(reduce(dismissed, { type: "caption", text: "still here" }).presence).toBe("visible");
  });

  test("a drag to nowhere leaves the widget where it was", () => {
    const placed = applyGesture(INITIAL_STATE, { type: "drag", x: 10, y: 20 });
    expect(applyGesture(placed, { type: "drag", x: Number.NaN, y: 5 })).toEqual(placed);
    expect(applyGesture(placed, { type: "drag" })).toEqual(placed);
  });
});

test("the widget's vocabulary is exactly the hub's", () => {
  // The widget carries its own copy of the vocabulary because it is a separate
  // process that loads in a browser context with no build step. This is what
  // keeps that copy from quietly becoming a disagreement: the lists are
  // compared against the hub's own, so a word added on one side and not the
  // other fails here rather than in front of a user.
  expect([...UNDERSTOOD_EVENTS].sort()).toEqual([...STATE_EVENT_TYPES].sort());
  expect([...OFFERED_GESTURES].sort()).toEqual([...GESTURE_TYPES].sort());
});

test("every word the hub can say has a case in the reducer", () => {
  // Totality, checked rather than assumed: an event the reducer silently
  // ignores would be a face that stops responding to something the hub
  // considers part of the conversation.
  const woken = reduce(INITIAL_STATE, { type: "wake_opened" });
  for (const type of STATE_EVENT_TYPES) {
    const next = reduce(woken, { type, text: "x" });
    expect(next, `no case for "${type}"`).not.toBe(woken);
  }
});
