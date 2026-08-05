/**
 * What the widget is, at any moment, given everything the hub has said.
 *
 * This is the whole widget, really. The shell around it opens a window and
 * paints pixels; the decisions about whether there is anything to look at, what
 * it is doing, and what words are under it are all made here, in a function
 * that takes a state and an event and returns a state.
 *
 * It is kept free of Electron and free of the DOM on purpose. A face whose
 * behaviour can only be exercised by opening a window on a machine with a
 * screen is a face whose behaviour is not exercised, and the properties this
 * process has to hold — appears on wake, fades on idle, says exactly what the
 * hub said — are worth more than that.
 *
 * The module ships as it is tested: the renderer loads this file, and so does
 * the test. There is no TypeScript twin to drift from it.
 */

/**
 * @typedef {"hidden" | "visible"} Presence
 * @typedef {"listening" | "thinking" | "speaking"} Activity
 * @typedef {{ id: string, x: number, y: number, width: number, height: number }} Scout
 * @typedef {{
 *   presence: Presence,
 *   activity: Activity,
 *   caption: string,
 *   muted: boolean,
 *   position: { x: number, y: number } | null,
 *   scouts: Scout[],
 * }} WidgetState
 */

/**
 * Absent, silent, unopinionated about where it sits, and pointing at nothing.
 *
 * `position` is null rather than a corner because the placement the user chose
 * belongs to the shell, which knows how big the screen is. Null means "wherever
 * you put me"; a value means "the user dragged me here".
 *
 * `scouts` is empty and stays empty until the hub says otherwise. An idle agent
 * is an agent touching nothing, and the widget has no other way to acquire a
 * rectangle — it cannot see the desktop, cannot ask where anything is, and
 * cannot infer a position from a caption. Every scout on the screen was put
 * there by the hub reporting work that was actually happening.
 */
export const INITIAL_STATE = /** @type {WidgetState} */ ({
  presence: "hidden",
  activity: "listening",
  caption: "",
  muted: false,
  position: null,
  scouts: [],
});

/**
 * The hub said something; here is what the widget becomes.
 *
 * Pure, and total over the vocabulary: every word the hub can say has a case,
 * and a word it cannot say leaves the state untouched. That last part matters
 * more than it looks — it means a hub that learns a new word before this widget
 * does gets an old widget that ignores it, not one that throws inside a socket
 * handler and dies holding a window open.
 *
 * @param {WidgetState} state
 * @param {{ type: string, text?: string, id?: string, x?: number, y?: number, width?: number, height?: number }} event
 * @returns {WidgetState}
 */
export function reduce(state, event) {
  switch (event.type) {
    case "wake_opened":
      // The gate opened, so there is a conversation now. The previous turn's
      // caption goes with it: the last thing said an hour ago is not a caption
      // for the thing being said now.
      return { ...state, presence: "visible", activity: "listening", caption: "" };

    case "caption":
      // Captions imply presence. A caption arriving while hidden means the
      // widget missed the wake — a face that started late, a socket that
      // reconnected mid-sentence — and the honest response is to show up
      // rather than to caption an invisible orb.
      return {
        ...state,
        presence: "visible",
        caption: typeof event.text === "string" ? event.text : "",
      };

    case "thinking":
      return { ...state, presence: "visible", activity: "thinking" };

    case "speaking":
      return { ...state, presence: "visible", activity: "speaking" };

    case "idle":
      // The turn is over: the widget fades and takes its caption with it, and
      // every scout with it too — nothing is being touched by an agent that
      // has stopped. Position and mute survive, because those are the user's
      // settings and not part of the conversation.
      return { ...state, presence: "hidden", activity: "listening", caption: "", scouts: [] };

    case "touching": {
      const scout = asScout(event);
      // A rectangle the widget cannot make sense of is dropped rather than
      // repaired. There is no sensible repair: every fallback position is a
      // place the agent is not working, which is the one thing a scout is not
      // allowed to be.
      if (!scout) return state;
      return {
        ...state,
        // A scout is an errand the orb sent out, so the orb is there to have
        // sent it. Drawing a hand with no arm would be a stranger sight than
        // arriving late, which is the same reasoning captions get.
        presence: "visible",
        // Keyed by the operation, so a second report about an operation
        // already in flight moves that scout instead of adding another.
        scouts: [...state.scouts.filter((existing) => existing.id !== scout.id), scout],
      };
    }

    case "released": {
      if (typeof event.id !== "string" || event.id === "") return state;
      const scouts = state.scouts.filter((existing) => existing.id !== event.id);
      return scouts.length === state.scouts.length ? state : { ...state, scouts };
    }

    default:
      return state;
  }
}

/**
 * A report about where the agent is working, or nothing.
 *
 * The hub's guard has already refused anything malformed by the time a frame
 * gets here, and this checks again anyway. The widget is a separate process
 * reading a socket, and a face whose drawing code trusts its input to have been
 * validated elsewhere is a face that draws whatever a bug upstream hands it.
 *
 * @param {{ id?: unknown, x?: unknown, y?: unknown, width?: unknown, height?: unknown }} event
 * @returns {Scout | null}
 */
function asScout(event) {
  const { id, x, y, width, height } = event;
  if (typeof id !== "string" || id === "") return null;
  for (const value of [x, y, width, height]) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
  }
  // A rectangle with no extent is not a place on a screen.
  if (/** @type {number} */ (width) <= 0 || /** @type {number} */ (height) <= 0) return null;
  return /** @type {Scout} */ ({ id, x, y, width, height });
}

/**
 * The user did something; here is what the widget becomes.
 *
 * Kept separate from `reduce` because these are different kinds of event with
 * different authority. The hub describes the world and the widget believes it;
 * the user asks for something and the widget both acts locally and tells the
 * hub. Folding them into one reducer would blur which of those two a given
 * transition was.
 *
 * @param {WidgetState} state
 * @param {{ type: string, x?: number, y?: number }} gesture
 * @returns {WidgetState}
 */
export function applyGesture(state, gesture) {
  switch (gesture.type) {
    case "mute":
      // Local, and also sent. The widget has no microphone to mute — the hub
      // owns the ears — so this flips the drawn state and the hub does the
      // actual muting when it hears about it.
      return { ...state, muted: !state.muted };

    case "dismiss":
      // Send the user away, not the conversation. Dismiss hides this turn's
      // face; the ears are the hub's and are not touched by it, and the next
      // wake brings the widget back. The scouts go with it — a person who
      // asked the face to leave did not ask to keep the parts of it that are
      // drawn over their own windows.
      return { ...state, presence: "hidden", caption: "", scouts: [] };

    case "drag":
      if (typeof gesture.x !== "number" || typeof gesture.y !== "number") return state;
      if (!Number.isFinite(gesture.x) || !Number.isFinite(gesture.y)) return state;
      return { ...state, position: { x: gesture.x, y: gesture.y } };

    default:
      return state;
  }
}

/**
 * Every state word the widget knows how to draw.
 *
 * Written here, in the widget, rather than imported from the hub: this is a
 * separate process that must load in a browser context with no build step and
 * no access to the hub's TypeScript. The copy is deliberate, and a test asserts
 * it equals the hub's own list exactly, so the duplication cannot quietly
 * become a disagreement.
 */
export const UNDERSTOOD_EVENTS = Object.freeze([
  "wake_opened",
  "caption",
  "thinking",
  "speaking",
  "idle",
  "touching",
  "released",
]);

/** Every gesture the widget can ask for. Same reasoning, same parity test. */
export const OFFERED_GESTURES = Object.freeze(["mute", "dismiss", "drag"]);
