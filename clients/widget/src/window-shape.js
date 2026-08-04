/**
 * Where the window goes and what it is allowed to do.
 *
 * Split out from the shell so it can be reasoned about — and tested — without
 * starting Electron. These are decisions about the widget's manners rather than
 * mechanics of opening a window, and they are worth checking on a machine with
 * no display.
 */

/** The window is a little bigger than the orb so the caption has somewhere to go. */
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
 * Where the widget sits when it has not been dragged.
 *
 * The user chooses corner or centre; corner is the default because a face that
 * appears in the middle of the screen every time somebody speaks is a face that
 * lands on top of whatever they were reading.
 *
 * @param {{ width: number, height: number }} area
 * @param {string} placement
 * @returns {{ x: number, y: number }}
 */
export function placeWindow(area, placement) {
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
