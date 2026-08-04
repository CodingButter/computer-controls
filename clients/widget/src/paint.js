/**
 * Turning a widget state into what a person sees.
 *
 * Split from the state machine because this is the half that touches a
 * document, and kept small enough to be handed a plain object in a test. The
 * shell calls it with real elements; the tests call it with the smallest thing
 * that has the properties it sets.
 */

/**
 * Put the transcript on the screen, exactly as the hub said it.
 *
 * `textContent`, never `innerHTML`, and that is not only the usual escaping
 * argument. A caption is a transcription of speech, so it contains whatever a
 * person said — brackets, ampersands, the word "script". Assigning it as HTML
 * would mean a sentence could stop being a sentence and start being markup,
 * which is both an injection and a lie about what was said. `textContent` is
 * the only assignment that renders a spoken line verbatim.
 *
 * No truncation and no ellipsis either. A caption that is too long is a layout
 * problem, and it is solved in CSS where it can be scrolled or wrapped, not by
 * throwing away the end of what somebody said.
 *
 * @param {{ textContent: string }} element
 * @param {string} text
 */
export function paintCaption(element, text) {
  element.textContent = text;
}

/**
 * The classes that describe the widget right now.
 *
 * Returned as a list rather than written onto an element so the mapping from
 * state to appearance is a value a test can read. The shell is what applies it.
 *
 * @param {{ presence: string, activity: string, muted: boolean }} state
 * @returns {string[]}
 */
export function presenceClasses(state) {
  const classes = [`presence-${state.presence}`, `activity-${state.activity}`];
  if (state.muted) classes.push("muted");
  return classes;
}

/**
 * How far the pointer must travel before a press becomes a drag.
 *
 * A few pixels, because a hand resting on a mouse moves. Without a threshold
 * every click would register as a one-pixel drag, and the click — which is the
 * mute — would never happen.
 */
export const DRAG_THRESHOLD_PX = 3;

/**
 * Whether a press that has now been released was a drag or a click.
 *
 * @param {{ x: number, y: number }} origin
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function wasDrag(origin, x, y) {
  return Math.abs(x - origin.x) + Math.abs(y - origin.y) > DRAG_THRESHOLD_PX;
}

/**
 * Whether the pointer is over something the widget actually drew.
 *
 * The window is a rectangle; the face inside it is a circle with a caption
 * under it. Everything else in that rectangle is transparent, and a transparent
 * pixel that swallows a click is a window that has quietly stolen part of the
 * user's desk. The shell asks this question to decide whether the pointer
 * belongs to the widget or to whatever is behind it.
 *
 * @param {{ x: number, y: number }} point relative to the window's top-left
 * @param {{ cx: number, cy: number, radius: number }} orb
 * @param {{ top: number, bottom: number, left: number, right: number } | null} [caption]
 * @returns {boolean}
 */
export function isOverVisibleShape(point, orb, caption = null) {
  const dx = point.x - orb.cx;
  const dy = point.y - orb.cy;
  if (dx * dx + dy * dy <= orb.radius * orb.radius) return true;

  if (!caption) return false;
  return (
    point.x >= caption.left &&
    point.x <= caption.right &&
    point.y >= caption.top &&
    point.y <= caption.bottom
  );
}
