import { expect, test, describe } from "vitest";

import { ScriptedEventSource } from "./source.ts";
import { combineEventSources, createTouchLane, harvestGeometry, targetOf } from "./touch-lane.ts";
import type { StateEvent } from "./types.ts";
import { isStateEvent } from "./types.ts";

/**
 * The claim under test is the one the face is worth having for: an orb never
 * appears anywhere the agent is not actually working.
 *
 * Everything below is a way of trying to make that false — an operation on an
 * element nobody measured, a result with no geometry in it, a backend that
 * reports no bounds at all, a tool that touches no element. Each one has to
 * come back silent rather than approximate.
 */

const BUTTON = "el-0123456789ab";
const FIELD = "el-abcdef012345";
const WINDOW = "win-0011223344ff";

/** What the daemon answers with: bounds ride inside the elements, never on top. */
function queryResult() {
  return {
    matchCount: 2,
    revision: 41,
    elements: [
      { id: BUTTON, role: "push button", bounds: { x: 1200, y: 640, width: 96, height: 32 } },
      {
        id: WINDOW,
        role: "frame",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        children: [{ id: FIELD, role: "text", bounds: { x: 300, y: 200, width: 420, height: 24 } }],
      },
    ],
  };
}

function collect(lane: { subscribe(handler: (event: StateEvent) => void): () => void }): StateEvent[] {
  const seen: StateEvent[] = [];
  lane.subscribe((event) => seen.push(event));
  return seen;
}

describe("the lane repeats geometry and never computes it", () => {
  test("test_a_scout_marks_the_element_an_operation_is_actually_touching", () => {
    const lane = createTouchLane();
    const seen = collect(lane);

    // The agent looks first, which is how the desktop's shape becomes known.
    lane.observe({ type: "tool_start", toolCallId: "call-1", toolName: "desktop_query_elements", args: { role: "push button" } });
    lane.observe({ type: "tool_end", toolCallId: "call-1", result: queryResult(), isError: false });

    // A query names no element, so it had nothing to point at.
    expect(seen).toEqual([]);

    lane.observe({ type: "tool_start", toolCallId: "call-2", toolName: "desktop_invoke_element", args: { elementId: BUTTON, clientId: "mastracode" } });

    // The scout is over the button's own reported rectangle, to the pixel.
    expect(seen).toEqual([{ type: "touching", id: "call-2", x: 1200, y: 640, width: 96, height: 32 }]);

    lane.observe({ type: "tool_end", toolCallId: "call-2", result: { completed: true }, isError: false });
    expect(seen.at(-1)).toEqual({ type: "released", id: "call-2" });
  });

  test("test_an_element_with_no_reported_geometry_produces_no_scout", () => {
    const lane = createTouchLane();
    const seen = collect(lane);

    // A backend that reports no bounds — the compositor path, or an element
    // that has never been described — is the honest-degradation case.
    lane.observe({ type: "tool_start", toolCallId: "call-1", toolName: "desktop_get_element", args: { elementId: FIELD } });
    lane.observe({
      type: "tool_end",
      toolCallId: "call-1",
      result: { element: { id: FIELD, role: "text" }, revision: 3, backend: "compositor" },
      isError: false,
    });
    lane.observe({ type: "tool_start", toolCallId: "call-2", toolName: "desktop_type_text", args: { elementId: FIELD, text: "hello" } });
    lane.observe({ type: "tool_end", toolCallId: "call-2", result: {}, isError: false });

    expect(seen).toEqual([]);
  });

  test("test_work_on_an_unmeasured_element_is_marked_only_once_the_answer_says_where", () => {
    const lane = createTouchLane();
    const seen = collect(lane);

    // Nothing is known about this element when the call starts, so nothing is
    // claimed. The answer carries the rectangle, and only then is the place
    // marked — and let go in the same breath, because the work is over.
    lane.observe({ type: "tool_start", toolCallId: "call-1", toolName: "desktop_inspect_element", args: { elementId: BUTTON } });
    expect(seen).toEqual([]);

    lane.observe({
      type: "tool_end",
      toolCallId: "call-1",
      result: { element: { id: BUTTON, bounds: { x: 10, y: 20, width: 30, height: 40 } }, revision: 7 },
      isError: false,
    });

    expect(seen).toEqual([
      { type: "touching", id: "call-1", x: 10, y: 20, width: 30, height: 40 },
      { type: "released", id: "call-1" },
    ]);
  });

  test("test_two_operations_on_one_element_are_two_scouts", () => {
    const lane = createTouchLane();
    const seen = collect(lane);

    lane.observe({ type: "tool_start", toolCallId: "seed", toolName: "desktop_query_elements", args: {} });
    lane.observe({ type: "tool_end", toolCallId: "seed", result: queryResult(), isError: false });

    lane.observe({ type: "tool_start", toolCallId: "a", toolName: "desktop_claim_element", args: { elementId: FIELD } });
    lane.observe({ type: "tool_start", toolCallId: "b", toolName: "desktop_attest_element", args: { elementId: FIELD } });
    lane.observe({ type: "tool_end", toolCallId: "a", result: {}, isError: false });

    // The id is the operation's, not the element's: one hand letting go does
    // not retract the other, and both were pointing at the same rectangle.
    expect(seen).toEqual([
      { type: "touching", id: "a", x: 300, y: 200, width: 420, height: 24 },
      { type: "touching", id: "b", x: 300, y: 200, width: 420, height: 24 },
      { type: "released", id: "a" },
    ]);
  });

  test("test_a_failed_operation_still_lets_go", () => {
    const lane = createTouchLane();
    const seen = collect(lane);

    lane.observe({ type: "tool_start", toolCallId: "seed", toolName: "desktop_query_elements", args: {} });
    lane.observe({ type: "tool_end", toolCallId: "seed", result: queryResult(), isError: false });
    lane.observe({ type: "tool_start", toolCallId: "call-1", toolName: "desktop_invoke_element", args: { elementId: BUTTON } });
    lane.observe({ type: "tool_end", toolCallId: "call-1", result: { error: "ELEMENT_REFERENCE_STALE" }, isError: true });

    // A scout left drawn over a failure is a face still pointing at a hand
    // that let go.
    expect(seen.at(-1)).toEqual({ type: "released", id: "call-1" });
  });

  test("test_nothing_but_the_desktop_has_a_place_on_the_screen", () => {
    const lane = createTouchLane();
    const seen = collect(lane);

    lane.observe({ type: "tool_start", toolCallId: "seed", toolName: "desktop_query_elements", args: {} });
    lane.observe({ type: "tool_end", toolCallId: "seed", result: queryResult(), isError: false });

    // A tool from some other lane naming a field called `elementId` is not an
    // operation on this machine's desktop, and gets no scout.
    lane.observe({ type: "tool_start", toolCallId: "call-1", toolName: "view", args: { elementId: BUTTON } });
    // Events the lane has no business with leave it exactly as it was.
    lane.observe({ type: "thinking" } as never);
    lane.observe({ type: "shell_output", output: BUTTON, stream: "stdout" } as never);

    expect(seen).toEqual([]);
  });

  test("test_the_lane_emits_only_words_the_socket_admits", () => {
    const lane = createTouchLane();
    const seen = collect(lane);

    lane.observe({ type: "tool_start", toolCallId: "seed", toolName: "desktop_query_elements", args: {} });
    lane.observe({ type: "tool_end", toolCallId: "seed", result: queryResult(), isError: false });
    lane.observe({ type: "tool_start", toolCallId: "call-1", toolName: "desktop_focus_window", args: { windowId: WINDOW } });
    lane.observe({ type: "tool_end", toolCallId: "call-1", result: {}, isError: false });

    expect(seen.length).toBe(2);
    // The vocabulary is the boundary. A lane that emitted something the guard
    // refuses would be a lane whose frames a face silently drops.
    for (const event of seen) expect(isStateEvent(event)).toBe(true);
  });

  test("test_a_face_that_walks_away_stops_being_told", () => {
    const lane = createTouchLane();
    const seen: StateEvent[] = [];
    const unsubscribe = lane.subscribe((event) => seen.push(event));

    lane.observe({ type: "tool_start", toolCallId: "seed", toolName: "desktop_query_elements", args: {} });
    lane.observe({ type: "tool_end", toolCallId: "seed", result: queryResult(), isError: false });
    unsubscribe();
    lane.observe({ type: "tool_start", toolCallId: "call-1", toolName: "desktop_invoke_element", args: { elementId: BUTTON } });

    expect(seen).toEqual([]);
  });
});

describe("harvesting geometry from an answer", () => {
  test("finds elements however deep the answer nests them", () => {
    const found = harvestGeometry(queryResult());
    expect(found.get(BUTTON)).toEqual({ x: 1200, y: 640, width: 96, height: 32 });
    expect(found.get(FIELD)).toEqual({ x: 300, y: 200, width: 420, height: 24 });
    expect(found.get(WINDOW)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  test("takes geometry only from something that is an element reference", () => {
    const found = harvestGeometry({
      // A record that happens to own both words is not an element, and a scout
      // over whatever this is would be pointing at a coincidence.
      id: "invoice-2019",
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      entries: [{ id: "not-an-element", bounds: { x: 5, y: 6, width: 7, height: 8 } }],
    });
    expect(found.size).toBe(0);
  });

  test("refuses a rectangle that is not a place on a screen", () => {
    const found = harvestGeometry({
      elements: [
        { id: BUTTON, bounds: { x: 0, y: 0, width: 0, height: 0 } },
        { id: FIELD, bounds: { x: Number.NaN, y: 0, width: 10, height: 10 } },
        { id: WINDOW, bounds: { x: "12", y: 0, width: 10, height: 10 } },
      ],
    });
    expect(found.size).toBe(0);
  });

  test("keeps the most recent rectangle for an element that moved", () => {
    const ledger = harvestGeometry({ id: BUTTON, bounds: { x: 0, y: 0, width: 10, height: 10 } });
    harvestGeometry({ id: BUTTON, bounds: { x: 500, y: 500, width: 10, height: 10 } }, ledger);
    expect(ledger.get(BUTTON)).toEqual({ x: 500, y: 500, width: 10, height: 10 });
  });

  test("survives a result that refers to itself", () => {
    const cyclic: Record<string, unknown> = { id: BUTTON, bounds: { x: 1, y: 2, width: 3, height: 4 } };
    cyclic.self = cyclic;
    expect(harvestGeometry(cyclic).get(BUTTON)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  test("reads nothing out of a value that is not an answer", () => {
    for (const value of [null, undefined, 42, "el-0123456789ab", true]) {
      expect(harvestGeometry(value).size).toBe(0);
    }
  });
});

describe("what an operation is touching", () => {
  test("is the element or window it names", () => {
    expect(targetOf("desktop_invoke_element", { elementId: BUTTON })).toBe(BUTTON);
    expect(targetOf("desktop_capture_window", { windowId: WINDOW })).toBe(WINDOW);
  });

  test("is nothing when the call names no element", () => {
    expect(targetOf("desktop_list_applications", {})).toBeUndefined();
    expect(targetOf("desktop_capabilities", undefined)).toBeUndefined();
    expect(targetOf("desktop_invoke_element", { elementId: "../../etc/passwd" })).toBeUndefined();
    expect(targetOf("desktop_invoke_element", { elementId: 12 })).toBeUndefined();
  });

  test("is nothing when the tool is not a desktop tool", () => {
    expect(targetOf("view", { elementId: BUTTON })).toBeUndefined();
    expect(targetOf("search_content", { windowId: WINDOW })).toBeUndefined();
  });
});

describe("one socket, several sources", () => {
  test("a face hears every source and each source hears every gesture", () => {
    const conversation = new ScriptedEventSource();
    const lane = createTouchLane();
    const combined = combineEventSources(conversation, lane);
    const seen = collect(combined);

    conversation.emit({ type: "wake_opened" });
    lane.observe({ type: "tool_start", toolCallId: "seed", toolName: "desktop_query_elements", args: {} });
    lane.observe({ type: "tool_end", toolCallId: "seed", result: queryResult(), isError: false });
    lane.observe({ type: "tool_start", toolCallId: "call-1", toolName: "desktop_invoke_element", args: { elementId: BUTTON } });

    expect(seen).toEqual([
      { type: "wake_opened" },
      { type: "touching", id: "call-1", x: 1200, y: 640, width: 96, height: 32 },
    ]);

    // The lane has no gate to close and no opinion about mute; a source that
    // does not implement the half it was never given must not break the half
    // that does.
    combined.handleGesture?.({ type: "mute" });
    expect(conversation.received).toEqual([{ type: "mute" }]);
  });

  test("unsubscribing detaches from every source", () => {
    const conversation = new ScriptedEventSource();
    const lane = createTouchLane();
    const combined = combineEventSources(conversation, lane);
    const seen: StateEvent[] = [];
    const unsubscribe = combined.subscribe((event) => seen.push(event));

    unsubscribe();
    conversation.emit({ type: "wake_opened" });
    expect(conversation.watcherCount).toBe(0);
    expect(seen).toEqual([]);
  });
});
