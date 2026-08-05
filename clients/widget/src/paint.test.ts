import { describe, expect, test } from "vitest";

import { isOverVisibleShape, paintCaption, presenceClasses, scoutRects } from "./paint.js";
import { INITIAL_STATE, reduce } from "./state-machine.js";

/** The smallest thing that is enough of an element for a caption to land on. */
const element = () => ({ textContent: "" });

test("test_captions_render_the_hub_transcript_verbatim", () => {
  // Speech contains whatever a person said, and a caption line is the one
  // place a face could quietly edit the hub. Each of these is a way that
  // editing usually happens by accident.
  const spoken = [
    "what is on my calendar",
    // Punctuation and case survive: a transcript is not tidied on the way out.
    "Turn the lights DOWN — all of them, please.",
    // Markup stays a sentence. It is a thing a person can say out loud, and
    // rendering it as HTML would be both an injection and a lie about what
    // was said.
    "<script>alert('hi')</script>",
    "a && b || c",
    'she said "no" & left',
    // Whitespace is not trimmed. Leading space is what a partial transcript
    // from a streaming ear actually looks like.
    "  leading and trailing  ",
    // Long lines are not truncated. Where to put a long caption is a layout
    // question, answered in CSS, not by discarding the end of a sentence.
    "so ".repeat(400) + "end",
    // The empty caption is a real thing an ear produces between phrases.
    "",
    "emoji 🎤 and ünïcödé and 日本語",
    "line one\nline two",
  ];

  for (const text of spoken) {
    const node = element();
    paintCaption(node, text);
    expect(node.textContent).toBe(text);
  }

  // And the same thing through the whole path a caption actually travels:
  // off the socket, into the state machine, onto the screen.
  const node = element();
  const state = reduce(INITIAL_STATE, {
    type: "caption",
    text: "<b>verbatim</b> — every character",
  });
  paintCaption(node, state.caption);
  expect(node.textContent).toBe("<b>verbatim</b> — every character");
});

describe("what the widget draws", () => {
  test("describes its state as classes the stylesheet can dress", () => {
    expect(presenceClasses({ presence: "hidden", activity: "listening", muted: false })).toEqual([
      "presence-hidden",
      "activity-listening",
    ]);
    expect(presenceClasses({ presence: "visible", activity: "speaking", muted: true })).toEqual([
      "presence-visible",
      "activity-speaking",
      "muted",
    ]);
  });

  test("claims the pointer only where it actually drew something", () => {
    const orb = { cx: 100, cy: 100, radius: 40 };

    // The orb itself, and its edge.
    expect(isOverVisibleShape({ x: 100, y: 100 }, orb)).toBe(true);
    expect(isOverVisibleShape({ x: 140, y: 100 }, orb)).toBe(true);

    // The transparent rectangle around it belongs to whatever is behind the
    // widget. A window that swallowed clicks here would have quietly stolen
    // part of the user's desk.
    expect(isOverVisibleShape({ x: 0, y: 0 }, orb)).toBe(false);
    expect(isOverVisibleShape({ x: 145, y: 100 }, orb)).toBe(false);
    // The corner of the bounding box, which a rectangular hit test would take.
    expect(isOverVisibleShape({ x: 132, y: 132 }, orb)).toBe(false);

    // The caption under the orb is drawn, so it is the widget's too.
    const caption = { top: 150, bottom: 180, left: 20, right: 180 };
    expect(isOverVisibleShape({ x: 100, y: 165 }, orb, caption)).toBe(true);
    expect(isOverVisibleShape({ x: 100, y: 200 }, orb, caption)).toBe(false);
  });
});

describe("where the scouts land", () => {
  // A second monitor to the left of the primary one, which is the case that
  // makes screen coordinates and page coordinates visibly different numbers.
  const stage = { x: 1920, y: 0, width: 2560, height: 1440 };

  test("a reported rectangle is drawn at the place it actually is", () => {
    // The daemon says where a button is in screen pixels; the page draws from
    // its own top-left. This subtraction is the whole difference, and getting
    // it wrong is an orb hovering confidently over the wrong thing.
    expect(scoutRects([{ id: "op-1", x: 2000, y: 300, width: 120, height: 32 }], stage)).toEqual([
      { id: "op-1", left: 80, top: 300, width: 120, height: 32 },
    ]);
  });

  test("a rectangle on another display is not drawn at a wrong position", () => {
    // It is not drawn at all. Every alternative — clamping it to the edge,
    // projecting it, drawing it at the origin — puts an orb somewhere the
    // agent is not working, which is a progress bar that lies.
    const elsewhere = [
      // The monitor to the left, entirely.
      { id: "left", x: 0, y: 100, width: 200, height: 40 },
      // A third screen to the right.
      { id: "right", x: 4480, y: 100, width: 200, height: 40 },
      // Below the bottom edge of this one.
      { id: "under", x: 2000, y: 1440, width: 200, height: 40 },
      // Exactly abutting the left edge: adjacent, not overlapping.
      { id: "abutting", x: 1720, y: 100, width: 200, height: 40 },
    ];
    expect(scoutRects(elsewhere, stage)).toEqual([]);
  });

  test("a window straddling the edge is half here, and half here is drawn", () => {
    // It genuinely is on this screen, and the window clips the rest. Refusing
    // it would be as dishonest in the other direction.
    expect(scoutRects([{ id: "op-1", x: 1900, y: 10, width: 200, height: 40 }], stage)).toEqual([
      { id: "op-1", left: -20, top: 10, width: 200, height: 40 },
    ]);
  });

  test("no work means no scouts", () => {
    expect(scoutRects([], stage)).toEqual([]);
  });
});
