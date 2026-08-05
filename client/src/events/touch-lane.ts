import type { AgentControllerEvent } from "@mastra/core/agent-controller";

import type { EventSource } from "./source.ts";
import type { Gesture, StateEvent } from "./types.ts";

/**
 * Where the agent's hands are, said out loud.
 *
 * A face that roams the desktop is only worth having if it points at real work.
 * This lane is the reportage: it watches the same controller event stream the
 * orb narrates from, and turns the desktop tool calls it sees into `touching`
 * and `released` — one pair per operation, carrying the screen rectangle the
 * daemon already reported for the element being worked on.
 *
 * Two facts make that honest rather than decorative.
 *
 * The first is that no position is ever computed here. The daemon answers with
 * bounds on the elements it describes, and this lane does nothing but remember
 * them and repeat them. A rectangle it has not been told is a scout that does
 * not appear — never a guess, never the middle of the screen, never the last
 * place that worked. An orb over the wrong button is worse than no orb, because
 * it is a claim about somebody's desktop that happens to be false.
 *
 * The second is that the lane sits on the observation side of the wall. It
 * reads events that already happened, and it reaches nothing: no daemon call,
 * no tool, no way to ask where something is. It cannot cause a desktop
 * operation, so pointing at one costs nothing and is governed by the consent
 * ceiling the operation already passed.
 */

/** A screen rectangle, exactly as the daemon reports one. */
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * An element reference, by the protocol's own pattern.
 *
 * Matching the shape rather than trusting any `{ id, bounds }` pair keeps the
 * harvest from picking geometry off some unrelated record that happens to use
 * both words — a plausible thing for a tool result to contain, and a source of
 * scouts pointing at nothing in particular.
 */
const ELEMENT_ID = /^(el|win|app)-[0-9a-f]{12}$/;

/** Only the desktop reaches a screen. Nothing else the hub holds has a place. */
const DESKTOP_TOOL = /^desktop_/;

/**
 * How much of a tool result is worth walking for geometry.
 *
 * An inspect of a large window comes back as a deep tree, and this runs on
 * every result. The budget is generous enough for real answers and finite
 * enough that a pathological one cannot hold the event loop.
 */
const WALK_BUDGET = 20_000;

/**
 * How many rectangles to remember, and how many operations to track.
 *
 * Both are caps on a process that runs all day rather than tuning. The
 * geometry ledger is a cache of what the desktop looked like recently; the
 * in-flight table should hold single digits in practice, and anything above
 * this is an operation whose end was never reported.
 */
const REMEMBERED_RECTS = 512;
const TRACKED_OPERATIONS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRect(value: unknown): Rect | undefined {
  if (!isRecord(value) || Array.isArray(value)) return undefined;
  const { x, y, width, height } = value;
  if (typeof x !== "number" || !Number.isFinite(x)) return undefined;
  if (typeof y !== "number" || !Number.isFinite(y)) return undefined;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return undefined;
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return undefined;
  return { x, y, width, height };
}

/**
 * Every element rectangle a tool result mentions, however deeply.
 *
 * Bounds ride inside the elements a method returns — nested in `children`, in
 * `ancestry`, in a list of matches — and no method answers with a rectangle at
 * the top level. So the ledger is filled by walking whatever came back rather
 * than by reading a field, which also means it keeps working when a method
 * starts answering with elements it did not answer with before.
 *
 * Exported because it is the whole claim to accuracy: what this function finds
 * is what a scout is allowed to be drawn over.
 */
export function harvestGeometry(value: unknown, into: Map<string, Rect> = new Map()): Map<string, Rect> {
  let budget = WALK_BUDGET;
  const seen = new Set<object>();

  const walk = (node: unknown): void => {
    if (budget-- <= 0) return;
    if (!isRecord(node)) return;
    // Results are JSON, but a result assembled in-process can carry a cycle,
    // and a walk that trusted otherwise would hang on one.
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const id = node.id;
    if (typeof id === "string" && ELEMENT_ID.test(id)) {
      const rect = asRect(node.bounds);
      if (rect) remember(into, id, rect);
    }

    for (const child of Object.values(node)) walk(child);
  };

  walk(value);
  return into;
}

function remember(ledger: Map<string, Rect>, id: string, rect: Rect): void {
  // Re-inserting rather than overwriting keeps the map ordered by how recently
  // the desktop said something about each element, which is what the eviction
  // below wants to be true.
  ledger.delete(id);
  ledger.set(id, rect);
  while (ledger.size > REMEMBERED_RECTS) {
    const oldest = ledger.keys().next();
    if (oldest.done) break;
    ledger.delete(oldest.value);
  }
}

/**
 * The element or window an operation names, if it names one.
 *
 * Read off the arguments rather than the result because a scout has to appear
 * when the work starts, not when it finishes. A call that names nothing —
 * listing applications, asking for capabilities — is work with no place on the
 * screen, and produces no scout.
 */
export function targetOf(toolName: string, args: unknown): string | undefined {
  if (!DESKTOP_TOOL.test(toolName)) return undefined;
  if (!isRecord(args) || Array.isArray(args)) return undefined;
  for (const key of ["elementId", "windowId"]) {
    const value = args[key];
    if (typeof value === "string" && ELEMENT_ID.test(value)) return value;
  }
  return undefined;
}

export type TouchLane = EventSource & {
  /**
   * One controller event from a turn in flight.
   *
   * Safe to call for every event of every turn: anything that is not a desktop
   * tool starting or finishing leaves the lane exactly as it was.
   */
  observe(event: AgentControllerEvent): void;
};

export function createTouchLane(): TouchLane {
  const handlers = new Set<(event: StateEvent) => void>();
  /** What the desktop last said about where things are. */
  const geometry = new Map<string, Rect>();
  /** Operations in flight, and the element each one named. */
  const inFlight = new Map<string, string>();
  /** Of those, the ones a face was told about — the scouts currently drawn. */
  const announced = new Set<string>();

  const emit = (event: StateEvent): void => {
    for (const handler of [...handlers]) handler(event);
  };

  const release = (callId: string): void => {
    if (!announced.delete(callId)) return;
    emit({ type: "released", id: callId });
  };

  const track = (callId: string, target: string): void => {
    inFlight.set(callId, target);
    while (inFlight.size > TRACKED_OPERATIONS) {
      const oldest = inFlight.keys().next();
      if (oldest.done) break;
      inFlight.delete(oldest.value);
      // An operation whose end never arrived still has to let go of its scout,
      // or the face keeps pointing at a hand that is no longer there.
      release(oldest.value);
    }
  };

  return {
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    observe(event: AgentControllerEvent) {
      if (event.type === "tool_start") {
        const target = targetOf(event.toolName, event.args);
        if (!target) return;
        track(event.toolCallId, target);
        const rect = geometry.get(target);
        // No rectangle, no scout. The operation still runs and the agent still
        // works; the face simply has nothing true to say about where.
        if (!rect) return;
        announced.add(event.toolCallId);
        emit({ type: "touching", id: event.toolCallId, ...rect });
        return;
      }

      if (event.type === "tool_end") {
        const target = inFlight.get(event.toolCallId);
        inFlight.delete(event.toolCallId);
        harvestGeometry(event.result, geometry);

        if (announced.has(event.toolCallId)) {
          release(event.toolCallId);
          return;
        }

        // The answer is where the rectangle came from. An operation on an
        // element nobody had looked at yet is invisible while it runs and
        // known the moment it ends, so it is marked and let go in the same
        // breath: a scout that fades from the place the work just happened,
        // rather than a place nothing happened at all.
        const rect = target ? geometry.get(target) : undefined;
        if (!rect) return;
        emit({ type: "touching", id: event.toolCallId, ...rect });
        announced.add(event.toolCallId);
        release(event.toolCallId);
      }
    },
  };
}

/**
 * Several sources, one face.
 *
 * The orb says what the conversation is doing and the touch lane says where the
 * hands are; a face needs both on the one socket it is allowed to open. Merging
 * here rather than teaching either source about the other keeps each one
 * ignorant of the rest: the orb has never heard of a scout, and the lane has
 * never heard of a caption.
 */
export function combineEventSources(...sources: readonly EventSource[]): EventSource {
  return {
    subscribe(handler) {
      const unsubscribes = sources.map((source) => source.subscribe(handler));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    handleGesture(gesture: Gesture) {
      for (const source of sources) source.handleGesture?.(gesture);
    },
  };
}
