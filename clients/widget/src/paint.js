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
 * The scouts that belong on this screen, in this page's coordinates.
 *
 * Two jobs, and the second one is the point. The first is arithmetic: the hub
 * reports rectangles in screen pixels and the page draws in pixels from its own
 * top-left, so the stage origin comes off each one.
 *
 * The second is knowing when to say nothing. A desk with two monitors has
 * exactly one of them under this window, and an element on the other screen has
 * coordinates that are perfectly valid and completely elsewhere. Drawn anyway,
 * it would land at some arbitrary place on the wrong display — an orb hovering
 * over an innocent part of the screen, claiming the agent is working there. A
 * box that is not on this stage is not drawn at a wrong position; it is not
 * drawn. The face on the other monitor, if there is one, draws it correctly,
 * and if there is no face there then the truth is that nobody saw it.
 *
 * @param {{ id: string, x: number, y: number, width: number, height: number }[]} scouts
 * @param {{ x: number, y: number, width: number, height: number }} stage
 * @returns {{ id: string, left: number, top: number, width: number, height: number }[]}
 */
export function scoutRects(scouts, stage) {
  const rects = [];
  for (const scout of scouts) {
    const left = scout.x - stage.x;
    const top = scout.y - stage.y;
    // Overlap, not containment: a dialog straddling the edge of this display
    // is genuinely half here, and the window clips the rest.
    if (left + scout.width <= 0 || top + scout.height <= 0) continue;
    if (left >= stage.width || top >= stage.height) continue;
    rects.push({ id: scout.id, left, top, width: scout.width, height: scout.height });
  }
  return rects;
}

/**
 * Whether the pointer is over something the widget actually drew.
 *
 * The window is the whole display now; the face inside it is a circle with a
 * caption under it. Everything else in that window is transparent, and a
 * transparent pixel that swallows a click is a window that has quietly stolen
 * part of the user's desk. The shell asks this question to decide whether the
 * pointer belongs to the widget or to whatever is behind it. Scouts are never
 * part of the answer: they are drawn over the user's own windows, which is
 * exactly where a click must still land.
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
