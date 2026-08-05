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
 * One entry, and it is the whole list. The widget grew ears, so `media` is
 * granted — audio only, only to the widget's own page, and only while the
 * tray has not disabled it; `guardPermissions` in main.js is where those
 * clauses are enforced. Everything else stays denied for the old reason: a
 * widget that granted broadly would be one interesting feature away from a
 * leak, and a thing that draws and listens needs exactly a microphone and
 * nothing further. Display capture is refused permanently in every state —
 * it is not on this list and never will be.
 */
export const GRANTED_PERMISSIONS = Object.freeze(["media"]);

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
 * hugging one edge leaves the other free — an orb snapped to the left edge
 * still sits at whatever height the user dragged it to.
 *
 * @typedef {{ h: "left" | "center" | "right" | null, v: "top" | "middle" | "bottom" | null }} SnapZone
 */

/** Snapped to nothing: the position is exactly where the user let go. */
export const FREE_ZONE = Object.freeze({ h: null, v: null });

/** The orb's top-left when it is pushed into each corner of a work area. */
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
 * Which snap zone, if any, a dragged orb has landed in.
 *
 * @param {{ x?: number, y?: number, width: number, height: number }} area work area, screen coordinates
 * @param {{ x: number, y: number }} point the orb's top-left, screen coordinates
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
 * Where the orb actually goes: snapped on the axes that snapped, and
 * clamped onto the work area on the axes that did not.
 *
 * The clamp is not decoration, and it survived the window becoming the whole
 * screen. An orb dragged off the bottom of a click-through stage is a face the
 * user cannot get back — it has no taskbar entry, no frame, and never takes
 * focus, so there is nothing left to grab.
 *
 * @param {{ x?: number, y?: number, width: number, height: number }} area
 * @param {{ x: number, y: number }} point the orb's top-left, screen coordinates
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
 * The end of a drag: where the orb lands, and what that landing meant.
 *
 * @param {{ x?: number, y?: number, width: number, height: number }} area
 * @param {{ x: number, y: number }} point the orb's top-left, screen coordinates
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
 * whether shift is down; the shell owns the arithmetic. That division did not
 * change when the window became the stage, and it matters more now, not less:
 * the page is never told where its own window is, so travel-since-press is the
 * only thing it can honestly report. Everything else is refused, including the
 * shapes a broken page would send — a NaN reaching the placement would put the
 * face somewhere nobody can find it. Negative deltas are ordinary: a second
 * monitor sits at negative coordinates on most desks.
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
 * `orb` is where the face starts: a remembered placement resolved against this
 * display's work area, or the default corner when there is nothing remembered.
 * The window no longer moves when the face does, so this is the only thing a
 * drag changes.
 *
 * @param {{ bounds: { x: number, y: number, width: number, height: number }, workArea: { x: number, y: number, width: number, height: number } }} display
 * @param {string | { x: number, y: number, zone?: SnapZone }} placement a named default, or a remembered spot
 * @returns {{ x: number, y: number, width: number, height: number, orb: { x: number, y: number } }}
 */
export function stageFor(display, placement) {
  const orb =
    typeof placement === "string"
      ? (() => {
          const placed = placeOrb(display.workArea, placement);
          // `placeOrb` answers in work-area coordinates; everything else in
          // this module is in screen coordinates, so it is lifted once here.
          return {
            x: (display.workArea.x ?? 0) + placed.x,
            y: (display.workArea.y ?? 0) + placed.y,
          };
        })()
      : restorePlacement(display.workArea, placement);
  return {
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    // In screen coordinates, like everything else the widget is told about
    // where things are. The renderer subtracts the stage origin once, in one
    // place, rather than every consumer remembering which space it is in.
    orb,
  };
}
