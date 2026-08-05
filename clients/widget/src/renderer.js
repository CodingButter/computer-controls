/**
 * The page: state in, pixels out, gestures back.
 *
 * Everything this module does is drawing and forwarding. It holds the current
 * state, paints it, and turns three user actions into the three gestures the
 * hub offers. It asks for no permission, opens no other connection, and reads
 * nothing off the machine — there is nothing here that could, which is the
 * property the whole design is arranged around.
 */

import { connectToHub } from "./connection.js";
import {
  isOverVisibleShape,
  paintCaption,
  presenceClasses,
  scoutRects,
  wasDrag,
} from "./paint.js";
import { AUTO_HIDE_MS, INITIAL_STATE, applyGesture, fade, reduce } from "./state-machine.js";
import { mountWebGlOrb, syntheticLevel, hasWebGl } from "./face/orb-webgl.js";
import { shaderStateFor } from "./face-state.js";
import { HEIGHT, WIDTH, placeOrb } from "./window-shape.js";

const root = document.getElementById("widget");
const orbElement = document.getElementById("orb");
const orbCanvas = document.getElementById("orb-canvas");
const captionElement = document.getElementById("caption");
const menuElement = document.getElementById("menu");
const menuDashboard = document.getElementById("menu-dashboard");
const menuDismiss = document.getElementById("menu-dismiss");
const menuQuit = document.getElementById("menu-quit");
const scoutLayer = document.getElementById("scouts");

/*
 * Which piece of desk this window is, and therefore what "here" means.
 *
 * The shell measured it and handed it down at load. Without it the page still
 * draws a face — at the default corner of its own window, which is where it
 * would have been anyway — but it draws no scouts at all: every rectangle the
 * hub reports is in screen coordinates, and a page that does not know where it
 * is on the screen can only guess at where they land. A guessed scout is the
 * one thing this feature must never produce, so the absence is honest and
 * silent rather than approximate.
 */
const stage = window.widget.stage ?? null;
const defaultOrb = stage
  ? { x: stage.orb.x - stage.x, y: stage.orb.y - stage.y }
  : placeOrb({ width: window.innerWidth, height: window.innerHeight }, "corner");

let state = INITIAL_STATE;
let webglOrb = null;
// Where the shell last said the orb is, in this page's coordinates. It is the
// answer to a drag rather than a guess made alongside one: the snapping and the
// clamping happen where the shape of the desk is known, and this is what came
// back.
let placed = null;
// The shader reads a single face state rather than the widget's
// presence+activity pair. The mapping is pure and tested apart from this DOM.
let shaderState = shaderStateFor(state);

/**
 * The orb's top-left in this page's coordinates.
 *
 * The user's dragged position is a screen coordinate, like everything else the
 * widget is told about where things are, so the stage origin comes off it.
 * Clamped to the window: a face dragged past the edge of the desk would be a
 * face the user cannot get back.
 *
 * @returns {{ x: number, y: number }}
 */
function orbOrigin() {
  if (placed) return clampToPage(placed);
  const chosen = state.position;
  if (!chosen) return defaultOrb;
  const local = stage ? { x: chosen.x - stage.x, y: chosen.y - stage.y } : chosen;
  return clampToPage(local);
}

/**
 * Inside the page, always.
 *
 * The shell clamps to the work area and this clamps to the window, and both are
 * worth doing: they are answers to different questions, and the second one is
 * the one that holds when a remembered position arrives from a desk that has
 * since changed shape.
 *
 * @param {{ x: number, y: number }} point
 * @returns {{ x: number, y: number }}
 */
function clampToPage(point) {
  return {
    x: Math.min(Math.max(0, point.x), Math.max(0, window.innerWidth - WIDTH)),
    y: Math.min(Math.max(0, point.y), Math.max(0, window.innerHeight - HEIGHT)),
  };
}

/*
 * The scouts: one small orb per thing the agent is touching, drawn over the
 * rectangle the desktop reported for it.
 *
 * They are rebuilt from the state rather than animated in and out by hand,
 * because the state is the only record of what is genuinely in flight. Nothing
 * here can put a scout on the screen that the hub did not report, and nothing
 * here can keep one alive after the operation ended.
 */
function paintScouts() {
  const rects = stage ? scoutRects(state.scouts, stage) : [];
  const wanted = new Set(rects.map((rect) => rect.id));
  for (const drawn of scoutLayer.children) {
    if (!wanted.has(drawn.dataset.scout)) drawn.remove();
  }
  for (const rect of rects) {
    let element = scoutLayer.querySelector(`[data-scout="${CSS.escape(rect.id)}"]`);
    if (!element) {
      element = document.createElement("div");
      element.className = "scout";
      element.dataset.scout = rect.id;
      scoutLayer.append(element);
    }
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
  }
}

function paint() {
  root.className = presenceClasses(state).join(" ");
  const origin = orbOrigin();
  root.style.left = `${origin.x}px`;
  root.style.top = `${origin.y}px`;
  root.style.width = `${WIDTH}px`;
  root.style.height = `${HEIGHT}px`;
  paintCaption(captionElement, state.caption);
  paintScouts();
  shaderState = shaderStateFor(state);
  webglOrb?.setState(shaderState);
}

// The shell answers every drag with a place to draw. Nothing else moves the
// orb: a position that arrived from the hub is where the face was left, and a
// position that arrives here is where the hand just put it.
window.widget.onPlaced?.((placement) => {
  if (!Number.isFinite(placement.x) || !Number.isFinite(placement.y)) return;
  placed = placement;
  paint();
});

/*
 * Auto-hide: the face lingers a readable while after the conversation rests,
 * then fades — if the user left that choice on.
 *
 * The timer runs here because this is the process that sees the lane: every
 * event lands in `reduce` and rewinds the clock, so a face that is listening
 * to someone or saying something is structurally a face whose timer has not
 * fired — "visible while active" is not a race against the timeout. The
 * setting itself arrives from the shell over a receive-only channel; this
 * page can be told auto-hide is off, and can never turn its own off.
 */
let autoHide = true;
let fadeTimer = null;

function rewindFade() {
  clearTimeout(fadeTimer);
  fadeTimer = null;
  if (state.presence !== "visible") return;
  fadeTimer = setTimeout(() => {
    state = fade(state, autoHide);
    paint();
  }, AUTO_HIDE_MS);
}

window.widget.onTrayState?.((next) => {
  autoHide = next.autoHide;
  rewindFade();
});

const hub = connectToHub({
  port: window.widget.hubPort,
  onEvent: (event) => {
    state = reduce(state, event);
    paint();
    rewindFade();
  },
});

/**
 * Do it here, and tell the hub.
 *
 * Both halves are needed and neither is sufficient. Drawing it locally is what
 * makes the widget feel like it responded; telling the hub is what makes it
 * true, because the hub owns the ears and this process owns nothing.
 *
 * @param {{ type: string, x?: number, y?: number }} gesture
 */
function perform(gesture) {
  state = applyGesture(state, gesture);
  paint();
  // A hand on the face is a person using it: not the moment to fade away.
  rewindFade();
  hub.send(gesture);
}

/*
 * The pointer decides who owns the click.
 *
 * The window is a mostly-transparent rectangle sitting on top of the user's
 * work, so it tells the shell to let clicks through by default and claims them
 * back only while the pointer is genuinely over something it drew.
 *
 * The window is now the whole display, which makes this the load-bearing part
 * of the design rather than a nicety: every pixel of the user's desk is under
 * it. The hit-test is deliberately the orb and its caption and nothing else —
 * a scout is drawn directly over a control the agent is working on, and a
 * scout that claimed the pointer would take clicks meant for exactly the thing
 * it is pointing at.
 */
let claiming = false;
window.addEventListener("mousemove", (event) => {
  // While the menu is open, claiming stays locked: the pointer may move off
  // the orb onto the menu, which is not part of the visible-shape hit-test,
  // and a mousemove that released clicks would drop the menu through the
  // floor.
  if (menuVisible) return;
  // A drag locks it for a harder reason. A hand moving faster than the window
  // follows leaves the pointer outside the orb for a frame, and releasing the
  // claim there would hand the rest of the gesture — including the mouseup —
  // to whatever is behind the widget, dropping the face mid-drag.
  if (dragging) return;
  const orb = orbElement.getBoundingClientRect();
  const caption = state.caption ? captionElement.getBoundingClientRect() : null;
  const over = isOverVisibleShape(
    { x: event.clientX, y: event.clientY },
    { cx: orb.left + orb.width / 2, cy: orb.top + orb.height / 2, radius: orb.width / 2 },
    caption,
  );
  if (over === claiming) return;
  claiming = over;
  // Hover acknowledges the pointer and does nothing else: no gesture, no
  // message, no record that the pointer was ever there. It is the one piece of
  // feedback that tells the user the orb is a thing that can be touched rather
  // than a picture painted on the desk.
  orbElement.classList.toggle("hovered", over);
  window.widget.setPointerOverShape(over);
});

/*
 * The menu: the one way out of a face that has no frame, no taskbar entry, and
 * never takes focus.
 *
 * Right-click opens it where the pointer is. While it is open, the window
 * keeps claiming clicks so the buttons stay clickable, and a click anywhere
 * else — on the orb, on transparent pixels the window is capturing — closes
 * it. The three items are the three things the face can do that are not
 * gestures: show the user the dashboard, go away for this turn, or go away for
 * good.
 */
let menuVisible = false;

/** @param {number} x @param {number} y */
function showMenu(x, y) {
  menuElement.style.left = `${x}px`;
  menuElement.style.top = `${y}px`;
  menuElement.hidden = false;
  menuVisible = true;
  claiming = true;
  window.widget.setPointerOverShape(true);
}

function hideMenu() {
  menuElement.hidden = true;
  menuVisible = false;
  claiming = false;
  window.widget.setPointerOverShape(false);
}

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  if (menuVisible) hideMenu();
  else showMenu(event.clientX, event.clientY);
});

menuDashboard.addEventListener("click", () => {
  hideMenu();
  // Shell-level, like quit: the hub is not asked for permission to show the
  // user their own settings page, and nothing about this crosses the socket.
  window.widget.openDashboard();
});

menuDismiss.addEventListener("click", () => {
  hideMenu();
  perform({ type: "dismiss" });
});

menuQuit.addEventListener("click", () => {
  hideMenu();
  window.widget.quit();
});

// A click outside the menu closes it. This fires before the contextmenu
// event on a right-click, so a second right-click repositions rather than
// toggling: the mousedown hides, then contextmenu shows at the new spot.
window.addEventListener("mousedown", (event) => {
  if (!menuVisible) return;
  if (menuElement.contains(event.target)) return;
  hideMenu();
});

/*
 * Dragging moves the face.
 *
 * Two things happen, and they are different things.
 *
 * The face follows the hand — and the shell is the half that decides where it
 * lands, asked for here as a distance travelled since the press, because the
 * page has no idea where its own window sits on the desk. What moves is the orb
 * inside the stage rather than the window under the compositor, which is what
 * makes the face something that can be anywhere: a window that moved would be a
 * window that could only ever be in one place at a time, and the scouts need
 * the whole desk. Where it ended up comes back through `onPlaced`, in this
 * page's coordinates, and that answer is the only thing drawn — no local guess
 * runs alongside it, so a snap is never briefly overruled by a preview.
 *
 * And the position is reported to the hub, so the other faces and the next
 * launch agree about where the user put it; the widget is not the owner of that
 * preference any more than it is the owner of anything else.
 *
 * Holding shift while dragging asks for a snap. Which edge, corner, or centre
 * that lands on — or whether the release was too far from any of them to snap
 * at all — is decided by the shell, which is the half that knows the shape of
 * the screen.
 */
let dragging = null;
orbElement.addEventListener("mousedown", (event) => {
  if (menuVisible) return;
  // The left button drags and, without travel, mutes. The right button belongs
  // to the menu: a right-click that also started a drag would end its own
  // mouseup as a mute, and silence the ears on the way to opening a menu.
  if (event.button !== 0) return;
  dragging = { x: event.screenX, y: event.screenY, moved: false };
  window.widget.drag("begin", 0, 0, event.shiftKey);
});
window.addEventListener("mousemove", (event) => {
  if (!dragging) return;
  if (wasDrag(dragging, event.screenX, event.screenY)) dragging.moved = true;
  // Below the threshold nothing moves, so a hand resting on the mouse does not
  // nudge the face a pixel sideways on its way to a click.
  if (!dragging.moved) return;
  window.widget.drag("move", event.screenX - dragging.x, event.screenY - dragging.y, event.shiftKey);
});
window.addEventListener("mouseup", (event) => {
  if (!dragging) return;
  const { moved, x, y } = dragging;
  dragging = null;

  // Press and release without travelling is a click, and a click on the orb
  // is the mute. Dragging a widget across the desk must not also mute it,
  // which is what a plain `click` listener beside this one would have done.
  if (!moved) {
    perform({ type: "mute" });
    return;
  }
  window.widget.drag("end", event.screenX - x, event.screenY - y, event.shiftKey);
  // Back in screen coordinates, which is the space the hub is told about
  // positions in — and taken from where the orb actually landed rather than
  // from where the pointer happened to be, which are different by however far
  // down the face the user grabbed it.
  if (placed) perform({ type: "drag", x: placed.x + (stage?.x ?? 0), y: placed.y + (stage?.y ?? 0) });
});

/*
 * The same face the /orb page wears, rendered here when the machine can.
 *
 * WebGL is probed on a throwaway canvas: the display canvas remembers its first
 * context type forever, and three.js needs to claim its own. If the probe fails
 * — or three fails to load, or the context fails — the CSS orb was never
 * suppressed, so the widget is already in its fallback. This is the single
 * fallback decision point, the same shape the hub's page uses.
 *
 * The canvas is a child of #orb so the gesture and click-through geometry above
 * — keyed off #orb's bounding box — keep working unchanged.
 */
if (hasWebGl(document.createElement("canvas"))) {
  mountWebGlOrb({
    canvas: orbCanvas,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  })
    .then((orb3d) => {
      webglOrb = orb3d;
      orbElement.classList.add("webgl");
      webglOrb.setState(shaderState);
    })
    .catch(() => {
      // WebGL reported present but three or the context failed. The CSS orb was
      // never suppressed, so the widget is already in its fallback state.
    });
}

// The single animation loop: synthesize a level from the current face state and
// feed it to the shader each frame. When the CSS orb is the active face,
// webglOrb is null and this is a no-op — the same shape the hub's page uses.
const loop = (now) => {
  if (webglOrb) {
    webglOrb.setLevel(syntheticLevel(shaderState, now));
    webglOrb.tick(now);
  }
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

paint();
