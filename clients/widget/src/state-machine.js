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
 * @typedef {{
 *   presence: Presence,
 *   activity: Activity,
 *   caption: string,
 *   muted: boolean,
 *   position: { x: number, y: number } | null,
 * }} WidgetState
 */

/**
 * Absent, silent, and unopinionated about where it sits.
 *
 * `position` is null rather than a corner because the placement the user chose
 * belongs to the shell, which knows how big the screen is. Null means "wherever
 * you put me"; a value means "the user dragged me here".
 */
export const INITIAL_STATE = /** @type {WidgetState} */ ({
  presence: "hidden",
  activity: "listening",
  caption: "",
  muted: false,
  position: null,
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
 * @param {{ type: string, text?: string }} event
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
      // The turn is over: the widget fades and takes its caption with it.
      // Position and mute survive, because those are the user's settings and
      // not part of the conversation.
      return { ...state, presence: "hidden", activity: "listening", caption: "" };

    default:
      return state;
  }
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
      // wake brings the widget back.
      return { ...state, presence: "hidden", caption: "" };

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
]);

/** Every gesture the widget can ask for. Same reasoning, same parity test. */
export const OFFERED_GESTURES = Object.freeze(["mute", "dismiss", "drag"]);
