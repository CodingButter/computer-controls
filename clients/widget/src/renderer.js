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
import { isOverVisibleShape, paintCaption, presenceClasses, wasDrag } from "./paint.js";
import { INITIAL_STATE, applyGesture, reduce } from "./state-machine.js";
import { mountWebGlOrb, syntheticLevel, hasWebGl } from "./face/orb-webgl.js";
import { shaderStateFor } from "./face-state.js";

const root = document.getElementById("widget");
const orbElement = document.getElementById("orb");
const orbCanvas = document.getElementById("orb-canvas");
const captionElement = document.getElementById("caption");
const menuElement = document.getElementById("menu");
const menuDashboard = document.getElementById("menu-dashboard");
const menuDismiss = document.getElementById("menu-dismiss");
const menuQuit = document.getElementById("menu-quit");

let state = INITIAL_STATE;
let webglOrb = null;
// The shader reads a single face state rather than the widget's
// presence+activity pair. The mapping is pure and tested apart from this DOM.
let shaderState = shaderStateFor(state);

function paint() {
  root.className = presenceClasses(state).join(" ");
  paintCaption(captionElement, state.caption);
  shaderState = shaderStateFor(state);
  webglOrb?.setState(shaderState);
}

const hub = connectToHub({
  port: window.widget.hubPort,
  onEvent: (event) => {
    state = reduce(state, event);
    paint();
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
  hub.send(gesture);
}

/*
 * The pointer decides who owns the click.
 *
 * The window is a mostly-transparent rectangle sitting on top of the user's
 * work, so it tells the shell to let clicks through by default and claims them
 * back only while the pointer is genuinely over something it drew.
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
 * Two things happen, and they are different things. The window follows the
 * hand — that is the shell's job, asked for here as a distance travelled since
 * the press, because the page has no idea where its own window sits on the
 * desk. And the position is reported to the hub, so the other faces agree
 * about where the user put it; the widget is not the owner of that preference
 * any more than it is the owner of anything else.
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
  perform({ type: "drag", x: event.screenX, y: event.screenY });
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
