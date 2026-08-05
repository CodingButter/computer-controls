/**
 * Where the window goes and what it is allowed to do.
 *
 * Split out from the shell so it can be reasoned about — and tested — without
 * starting Electron. These are decisions about the widget's manners rather than
 * mechanics of opening a window, and they are worth checking on a machine with
 * no display.
 */

/**
 * The orb's own box — a little bigger than the orb so the caption has somewhere
 * to go.
 *
 * It used to be the window's size as well. It is not any more: the window is
 * the whole display now, and this is the box the renderer places inside it. A
 * face that only exists inside a 360-pixel rectangle cannot point at a button
 * on the other side of the screen, and pointing is what the window grew for.
 */
export const WIDTH = 360;
export const HEIGHT = 260;
const MARGIN = 24;

/**
 * Every permission this window will ever be granted.
 *
 * It is empty, and it is the whole list. Denying everything rather than the
 * microphone specifically is deliberate: a widget that blocked `media` and left
 * `geolocation` open would be one interesting feature away from a leak, and a
 * thing that draws has no legitimate use for any permission a browser can
 * grant. The empty list is the honest expression of that.
 */
export const GRANTED_PERMISSIONS = Object.freeze([]);

/**
 * Where the orb sits when it has not been dragged.
 *
 * The user chooses corner or centre; corner is the default because a face that
 * appears in the middle of the screen every time somebody speaks is a face that
 * lands on top of whatever they were reading.
 *
 * Measured against the work area rather than the whole display, so the default
 * corner is not underneath a panel or a dock.
 *
 * @param {{ width: number, height: number }} area
 * @param {string} placement
 * @returns {{ x: number, y: number }}
 */
export function placeOrb(area, placement) {
  if (placement === "center") {
    return {
      x: Math.max(0, Math.round((area.width - WIDTH) / 2)),
      y: Math.max(0, Math.round((area.height - HEIGHT) / 2)),
    };
  }
  return {
    x: Math.max(0, area.width - WIDTH - MARGIN),
    y: Math.max(0, area.height - HEIGHT - MARGIN),
  };
}

/**
 * The stage: the piece of desk the widget is drawing on.
 *
 * The window covers one whole display, transparent and click-through, and every
 * position inside it is the renderer's to decide. That is what lets the face
 * point at things: an element's rectangle arrives in screen coordinates, and a
 * window that spans the screen can draw over it.
 *
 * One display, not all of them. A window stretched across a desk to cover every
 * monitor would be a single surface whose transparency, scaling and refresh
 * behaviour is at the mercy of the least capable screen on it, and the honest
 * alternative is the rule this stage implies: a rectangle that is not on this
 * display is not drawn at a wrong position, it is not drawn.
 *
 * The origin travels with it because it is what makes the two coordinate
 * systems commensurable — the daemon speaks in screen pixels and a page speaks
 * in pixels from its own top-left, and this is the difference between them.
 *
 * @param {{ bounds: { x: number, y: number, width: number, height: number }, workArea: { x: number, y: number, width: number, height: number } }} display
 * @param {string} placement
 * @returns {{ x: number, y: number, width: number, height: number, orb: { x: number, y: number } }}
 */
export function stageFor(display, placement) {
  const placed = placeOrb(display.workArea, placement);
  return {
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    // In screen coordinates, like everything else the widget is told about
    // where things are. The renderer subtracts the stage origin once, in one
    // place, rather than every consumer remembering which space it is in.
    orb: { x: display.workArea.x + placed.x, y: display.workArea.y + placed.y },
  };
}
