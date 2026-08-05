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
  //
  // Each word is sampled as it is actually spoken, because some of them carry
  // fields and a reducer that dropped a malformed one would look identical to
  // a reducer with no case at all. The baseline is a widget already pointing at
  // something, so "released" has a scout to take away.
  const spoken: Record<string, Record<string, unknown>> = {
    wake_opened: {},
    caption: { text: "x" },
    thinking: {},
    speaking: {},
    idle: {},
    touching: { id: "op-1", x: 10, y: 20, width: 30, height: 40 },
    released: { id: "op-1" },
  };
  const woken = reduce(INITIAL_STATE, { type: "wake_opened" });
  const busy = reduce(woken, { type: "touching", ...spoken.touching });

  for (const type of STATE_EVENT_TYPES) {
    expect(spoken[type], `no sample for "${type}"`).toBeDefined();
    const next = reduce(busy, { type, ...spoken[type] });
    expect(next, `no case for "${type}"`).not.toBe(busy);
  }
});

describe("pointing at what is being touched", () => {
  const woken = reduce(INITIAL_STATE, { type: "wake_opened" });
  const touch = (id: string, x = 100, y = 200) => ({
    type: "touching",
    id,
    x,
    y,
    width: 80,
    height: 24,
  });

  test("an idle widget is pointing at nothing", () => {
    // The acceptance criterion, stated as the initial condition: no work, no
    // scouts. The widget has no other way to acquire one.
    expect(INITIAL_STATE.scouts).toEqual([]);
    expect(reduce(INITIAL_STATE, { type: "thinking" }).scouts).toEqual([]);
  });

  test("a scout lands on the rectangle the hub reported, and leaves when the work ends", () => {
    const touching = reduce(woken, touch("op-1"));
    expect(touching.scouts).toEqual([{ id: "op-1", x: 100, y: 200, width: 80, height: 24 }]);

    const released = reduce(touching, { type: "released", id: "op-1" });
    expect(released.scouts).toEqual([]);
    // Releasing something that was never held is not an error, it is a widget
    // that already agreed nothing is happening there.
    expect(reduce(released, { type: "released", id: "op-1" })).toBe(released);
  });

  test("one scout per operation, moved rather than multiplied", () => {
    const first = reduce(woken, touch("op-1", 10, 10));
    const second = reduce(first, touch("op-2", 900, 400));
    const moved = reduce(second, touch("op-1", 500, 500));

    expect(moved.scouts.map((scout) => scout.id).sort()).toEqual(["op-1", "op-2"]);
    expect(moved.scouts.find((scout) => scout.id === "op-1")).toMatchObject({ x: 500, y: 500 });
  });

  test("a scout implies the orb that sent it", () => {
    // A rectangle drawn on the desk with no face to have launched it would be
    // a hand with no arm — the same reasoning a caption arriving early gets.
    expect(reduce(INITIAL_STATE, touch("op-1")).presence).toBe("visible");
  });

  test("a rectangle that is not one is dropped, never repaired", () => {
    // Every repair is a position the agent is not working at, and a scout in a
    // place nothing is happening is the one thing this must never draw.
    const nonsense = [
      { type: "touching", x: 1, y: 2, width: 3, height: 4 },
      { type: "touching", id: "", x: 1, y: 2, width: 3, height: 4 },
      { type: "touching", id: "op-1", x: Number.NaN, y: 2, width: 3, height: 4 },
      { type: "touching", id: "op-1", x: 1, y: Number.POSITIVE_INFINITY, width: 3, height: 4 },
      { type: "touching", id: "op-1", x: 1, y: 2, width: 0, height: 4 },
      { type: "touching", id: "op-1", x: 1, y: 2, width: 3, height: -4 },
      { type: "touching", id: "op-1", x: 1, y: 2, width: 3 },
      { type: "released" },
    ];
    for (const event of nonsense) {
      expect(reduce(woken, event), JSON.stringify(event)).toBe(woken);
    }

    // A negative coordinate is not nonsense: a second monitor to the left of
    // the first one is a real desk.
    expect(reduce(woken, touch("op-1", -1920, -12)).scouts).toHaveLength(1);
  });

  test("nothing is being touched by an agent that has stopped", () => {
    const touching = reduce(woken, touch("op-1"));
    expect(reduce(touching, { type: "idle" }).scouts).toEqual([]);
    // And a face the user sent away takes what it drew over their windows with
    // it, rather than leaving rectangles behind on somebody else's screen.
    expect(applyGesture(touching, { type: "dismiss" }).scouts).toEqual([]);
  });
});
