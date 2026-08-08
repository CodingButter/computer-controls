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
 * This is the window's size. It briefly was not: the window grew to cover a
 * whole display so the face could draw over any element on it, and that shape
 * is what made the orb unable to leave the monitor it opened on. A window the
 * size of the face can be carried anywhere on the desk, which is the property
 * that mattered more.
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
 * Ask for a demonstrable window for this run without changing what is stored.
 *
 * A flag rather than an environment variable, and one door rather than two:
 * the tray remembers the choice, the flag makes it for a single launch, and
 * anybody scripting a recording gets the mode without leaving it on for the
 * person whose desk this is.
 */
export const DEMO_ARGUMENT = "--comcon-demo";

/**
 * @param {{ demo?: boolean }} stored — the tray's remembered choice.
 * @param {string[]} argv
 * @returns {boolean}
 */
export function demoRequested(stored, argv) {
  return argv.includes(DEMO_ARGUMENT) || Boolean(stored?.demo);
}

/**
 * What kind of window the shell opens: the ordinary face, or a demonstrable one.
 *
 * Both modes are now focusable, and therefore both are managed by the window
 * manager and visible to anything that enumerates windows. That used to be the
 * entire difference: the ordinary window declared itself unfocusable, which on
 * X11 is not a preference but an instruction to create the window
 * override-redirect, unmanaged and absent from `_NET_CLIENT_LIST` — invisible
 * to the switcher, to a screen recorder, to OBS's window source, and to this
 * project's own window-scoped capture. Demo mode existed to flip that one flag
 * for the twenty minutes somebody spends recording a demonstration.
 *
 * That flag is gone in both modes, because it was also silently discarding
 * `alwaysOnTop` and leaving the orb's visibility to stacking luck. So what is
 * left between the two modes is exactly two options:
 *
 *   skipTaskbar — a window worth recording is a window worth alt-tabbing to
 *   title       — an untitled window is unaddressable in a window picker
 *
 * Nothing else moves, and a test asserts that by diffing the two results. In
 * particular demo mode does not touch the permission handlers, the navigation
 * rules, or the click-through: a demo of the face is a demo of the face, not a
 * looser version of the program.
 *
 * @param {{ demo?: boolean }} [mode]
 */
export function windowOptionsFor({ demo = false } = {}) {
  return {
    // Frameless and transparent: the widget is an orb on the desk, not an
    // application window with a title bar and a close button.
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    // On top of the work, because being spoken to should not require finding
    // a window.
    alwaysOnTop: true,
    // Out of the taskbar and the switcher for the same reason — except while
    // demonstrating, when being findable is the entire request.
    skipTaskbar: !demo,
    resizable: false,
    // Dragging the orb moves this window: the window is the face's own box, so
    // carrying the face across the desk means carrying the window.
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Focusable, always, and the tradeoff is deliberate.
    //
    // This was `demo` — false ordinarily, true only while recording — because
    // an unfocusable window was believed to be the way a face avoids stealing
    // what the user is typing into. On X11 that flag does not mean "do not take
    // focus": Electron implements an unfocusable window as an override-redirect
    // one, which tells the window manager not to manage it at all. An unmanaged
    // window has no `_NET_WM_STATE_ABOVE` and no place in
    // `_NET_CLIENT_LIST_STACKING`, so `alwaysOnTop` above was silently
    // discarded and the orb's visibility was raw stacking luck — one raised
    // window away from buried.
    //
    // The flag goes and the guarantee stays: the shell only ever calls
    // `showInactive()`, never `show()` and never `focus()`, so the face still
    // never takes focus by appearing. What is given up is that clicking the orb
    // can now focus it — a deliberate act by the user, on a window they just
    // clicked, which is what every other window on the desk does.
    //
    // This also retires the reason demo mode existed to flip it: the ordinary
    // window is now managed, listed, and recordable. What demo mode still buys
    // is being findable in a switcher, which is the two options below.
    focusable: true,
    // A name, so a person choosing this window out of a list has something to
    // choose. Only in demo mode, because the ordinary window is not in any
    // list to be chosen from.
    title: demo ? "Mastra CC" : "",
    show: false,
  };
}

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
 * The clamp is not decoration. A face dragged off the bottom of the desk is a
 * face the user cannot get back — it has no taskbar entry, no frame, and is
 * never given focus, so there is nothing left to grab.
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
 * whether shift is down; the shell owns the arithmetic. The page is never told
 * where its own window is, so travel-since-press is the only thing it can
 * honestly report — and now that the report moves the window, that is the
 * whole seam. Everything else is refused, including the
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
 * The part of the window a photograph of the face may contain.
 *
 * The window is the orb's own box now, so this rectangle is usually the whole
 * window — but it is still stated rather than assumed. "Photograph my own
 * window" is a claim that stays honest only while the window and the face are
 * the same thing, and that has already changed once: the window used to be the
 * entire display. Naming the rectangle means the capture narrows itself if the
 * window ever grows again, instead of quietly widening into a picture of the
 * desk.
 *
 * The result is clamped into the window, because a face dragged to the very
 * edge of the desk has part of its box past the end of the stage, and a
 * capture rectangle that runs off the window is a rectangle the platform is
 * free to interpret.
 *
 * @param {{ x: number, y: number, width: number, height: number }} stage the window, screen coordinates
 * @param {{ x: number, y: number }} orb the orb's top-left, screen coordinates
 * @returns {{ x: number, y: number, width: number, height: number }} in window coordinates
 */
export function captureRect(stage, orb) {
  const width = Math.min(WIDTH, stage.width);
  const height = Math.min(HEIGHT, stage.height);
  return {
    x: Math.min(Math.max(Math.round(orb.x - stage.x), 0), stage.width - width),
    y: Math.min(Math.max(Math.round(orb.y - stage.y), 0), stage.height - height),
    width,
    height,
  };
}

/**
 * Whether the pointer is over something the widget actually drew.
 *
 * The window is the orb's own box, and even that box is mostly transparent: a
 * circle, sometimes a caption under it, sometimes a menu beside it, and corners
 * that are nothing at all. A transparent pixel that swallowed a click would be
 * a window quietly stealing part of the user's desk, so the shell asks this
 * before it takes the pointer.
 *
 * The circle is tested as a circle rather than as its bounding box, because the
 * corners of that box are visibly empty and clicking them must reach whatever
 * is behind. The rectangles are the drawn boxes — the caption, the open menu —
 * which are as rectangular as they look.
 *
 * It lives in this module rather than beside the painting code because both
 * halves need it and only one of them has a document: the page uses it to know
 * whether to look hovered, and the shell uses it against the real cursor.
 *
 * @param {{ x: number, y: number }} point relative to the window's top-left
 * @param {{ orb?: { cx: number, cy: number, radius: number } | null, rects?: { x: number, y: number, width: number, height: number }[] } | null} shapes
 * @returns {boolean}
 */
export function isOverVisibleShape(point, shapes) {
  if (!shapes) return false;

  const orb = shapes.orb;
  if (orb) {
    const dx = point.x - orb.cx;
    const dy = point.y - orb.cy;
    if (dx * dx + dy * dy <= orb.radius * orb.radius) return true;
  }

  for (const rect of shapes.rects ?? []) {
    if (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    ) {
      return true;
    }
  }
  return false;
}

/**
 * What the page says it drew, believed only if it is a shape.
 *
 * The page reports these so the shell can decide whether the window takes a
 * click, which makes them the one thing a broken page could use to make the
 * window eat the desk. A NaN radius compares false against everything, so a
 * malformed report is refused whole rather than repaired: `null` means nothing
 * is drawn, and nothing drawn is click-through, which is the safe answer.
 *
 * @param {unknown} shapes
 * @returns {{ orb: { cx: number, cy: number, radius: number } | null, rects: { x: number, y: number, width: number, height: number }[] } | null}
 */
export function readHitShapes(shapes) {
  if (!shapes || typeof shapes !== "object") return null;
  const { orb, rects } = /** @type {Record<string, unknown>} */ (shapes);

  let circle = null;
  if (orb !== null && orb !== undefined) {
    if (typeof orb !== "object") return null;
    const { cx, cy, radius } = /** @type {Record<string, unknown>} */ (orb);
    if (![cx, cy, radius].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    if (/** @type {number} */ (radius) <= 0) return null;
    circle = {
      cx: /** @type {number} */ (cx),
      cy: /** @type {number} */ (cy),
      radius: /** @type {number} */ (radius),
    };
  }

  const boxes = [];
  if (rects !== null && rects !== undefined) {
    if (!Array.isArray(rects)) return null;
    for (const rect of rects) {
      if (!rect || typeof rect !== "object") return null;
      const { x, y, width, height } = /** @type {Record<string, unknown>} */ (rect);
      if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) {
        return null;
      }
      // A rectangle with no extent is not a place on a screen.
      if (/** @type {number} */ (width) <= 0 || /** @type {number} */ (height) <= 0) continue;
      boxes.push({
        x: /** @type {number} */ (x),
        y: /** @type {number} */ (y),
        width: /** @type {number} */ (width),
        height: /** @type {number} */ (height),
      });
    }
  }

  if (!circle && boxes.length === 0) return null;
  return { orb: circle, rects: boxes };
}

/**
 * Where the window opens: the orb's own box, on the display it was left on.
 *
 * The window used to be the whole display — a transparent sheet over one
 * monitor with the orb drawn somewhere inside it. That shape had two costs the
 * desk made unpayable. A window covering a display cannot follow the face onto
 * a different one, so the orb was confined to whichever monitor the widget
 * opened on; and a window that size has to be click-through everywhere it is
 * not the face, which meant the widget's manners depended on a hit-test running
 * over every pixel of somebody's work.
 *
 * So the window is the face again: `WIDTH` by `HEIGHT`, placed where the orb
 * goes, and moved by the drag rather than redrawn inside a sheet. The
 * arithmetic that decides *where* is unchanged — a remembered placement
 * resolved against this display's work area, or the named default corner —
 * because that part was never the problem.
 *
 * Screen coordinates, because that is the space `BrowserWindow` bounds are in.
 *
 * @param {{ bounds: { x: number, y: number, width: number, height: number }, workArea: { x: number, y: number, width: number, height: number } }} display
 * @param {string | { x: number, y: number, zone?: SnapZone }} placement a named default, or a remembered spot
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function openingPlacement(display, placement) {
  const spot =
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
  return { x: spot.x, y: spot.y, width: WIDTH, height: HEIGHT };
}
