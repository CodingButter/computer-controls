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

/**
 * How close to an edge, a corner, or the centre a shift-drag has to land.
 *
 * Wide enough that a hand aiming at the edge of the screen hits it, narrow
 * enough that most of the desk is still free placement — which is the release
 * the issue asks for: hold shift near an edge and it snaps, let go anywhere
 * else and it stays exactly where it was put.
 */
export const SNAP_ZONE_PX = 64;

/**
 * A snap is remembered as an intention, not as a pair of pixels.
 *
 * "Bottom right of the screen" survives a monitor being unplugged, a
 * resolution change, and a taskbar appearing; the coordinates that happened to
 * mean bottom-right last Tuesday do not. Each axis is independent because
 * hugging one edge leaves the other free — a widget snapped to the left edge
 * still sits at whatever height the user dragged it to.
 *
 * @typedef {{ h: "left" | "center" | "right" | null, v: "top" | "middle" | "bottom" | null }} SnapZone
 */

/** Snapped to nothing: the position is exactly where the user let go. */
export const FREE_ZONE = Object.freeze({ h: null, v: null });

/** The window's top-left when it is pushed into each corner of a work area. */
function limits(area) {
  const originX = area.x ?? 0;
  const originY = area.y ?? 0;
  return {
    left: originX,
    right: originX + Math.max(0, area.width - WIDTH),
    centerX: originX + Math.max(0, Math.round((area.width - WIDTH) / 2)),
    top: originY,
    bottom: originY + Math.max(0, area.height - HEIGHT),
    middleY: originY + Math.max(0, Math.round((area.height - HEIGHT) / 2)),
  };
}

const near = (a, b) => Math.abs(a - b) <= SNAP_ZONE_PX;

/**
 * Which snap zone, if any, a dragged window has landed in.
 *
 * @param {{ x?: number, y?: number, width: number, height: number }} area work area, screen coordinates
 * @param {{ x: number, y: number }} point the window's top-left, screen coordinates
 * @returns {SnapZone}
 */
export function snapZoneFor(area, point) {
  const edge = limits(area);
  return {
    h: near(point.x, edge.left)
      ? "left"
      : near(point.x, edge.right)
        ? "right"
        : near(point.x, edge.centerX)
          ? "center"
          : null,
    v: near(point.y, edge.top)
      ? "top"
      : near(point.y, edge.bottom)
        ? "bottom"
        : near(point.y, edge.middleY)
          ? "middle"
          : null,
  };
}

/**
 * Where the window actually goes: snapped on the axes that snapped, and
 * clamped onto the work area on the axes that did not.
 *
 * The clamp is not decoration. A window dragged off the bottom of the screen
 * is a face the user cannot get back — it has no taskbar entry, no frame, and
 * never takes focus, so there is nothing left to grab.
 *
 * @param {{ x?: number, y?: number, width: number, height: number }} area
 * @param {{ x: number, y: number }} point the window's top-left, screen coordinates
 * @param {SnapZone} [zone]
 * @returns {{ x: number, y: number }}
 */
export function placeInZone(area, point, zone = FREE_ZONE) {
  const edge = limits(area);
  const clampedX = Math.min(Math.max(Math.round(point.x), edge.left), edge.right);
  const clampedY = Math.min(Math.max(Math.round(point.y), edge.top), edge.bottom);
  return {
    x: zone?.h === "left"
      ? edge.left
      : zone?.h === "right"
        ? edge.right
        : zone?.h === "center"
          ? edge.centerX
          : clampedX,
    y: zone?.v === "top"
      ? edge.top
      : zone?.v === "bottom"
        ? edge.bottom
        : zone?.v === "middle"
          ? edge.middleY
          : clampedY,
  };
}

/**
 * The end of a drag: where the window lands, and what that landing meant.
 *
 * @param {{ x?: number, y?: number, width: number, height: number }} area
 * @param {{ x: number, y: number }} point the window's top-left, screen coordinates
 * @param {boolean} snapping whether shift was held
 * @returns {{ x: number, y: number, zone: SnapZone }}
 */
export function dragPlacement(area, point, snapping) {
  const zone = snapping ? snapZoneFor(area, point) : FREE_ZONE;
  return { ...placeInZone(area, point, zone), zone };
}

/**
 * What a stored placement means on today's screen.
 *
 * A remembered snap is recomputed against the work area the widget is actually
 * opening on, so a face snapped to the bottom-right corner is still in the
 * corner after the monitor changed size. A free position is clamped rather
 * than recomputed, because a free position is a choice about a spot.
 *
 * @param {{ x?: number, y?: number, width: number, height: number }} area
 * @param {{ x: number, y: number, zone?: SnapZone }} stored
 * @returns {{ x: number, y: number }}
 */
export function restorePlacement(area, stored) {
  return placeInZone(area, stored, stored.zone ?? FREE_ZONE);
}

/**
 * What the page is allowed to say about a drag.
 *
 * The renderer reports how far the pointer has travelled since the press and
 * whether shift is down; the shell owns the window and does the arithmetic.
 * Everything else is refused, including the shapes a broken page would send —
 * a NaN reaching `setPosition` would move the face somewhere nobody can find
 * it. Negative deltas are ordinary: a second monitor sits at negative
 * coordinates on most desks.
 *
 * @param {unknown} request
 * @returns {{ phase: "begin" | "move" | "end", dx: number, dy: number, snap: boolean } | null}
 */
export function readDragRequest(request) {
  if (!request || typeof request !== "object") return null;
  const { phase, dx, dy, snap } = /** @type {Record<string, unknown>} */ (request);
  if (phase !== "begin" && phase !== "move" && phase !== "end") return null;
  if (typeof dx !== "number" || typeof dy !== "number") return null;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  return { phase, dx, dy, snap: snap === true };
}
