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

const root = document.getElementById("widget");
const orbElement = document.getElementById("orb");
const captionElement = document.getElementById("caption");

let state = INITIAL_STATE;

function paint() {
  root.className = presenceClasses(state).join(" ");
  paintCaption(captionElement, state.caption);
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
  const orb = orbElement.getBoundingClientRect();
  const caption = state.caption ? captionElement.getBoundingClientRect() : null;
  const over = isOverVisibleShape(
    { x: event.clientX, y: event.clientY },
    { cx: orb.left + orb.width / 2, cy: orb.top + orb.height / 2, radius: orb.width / 2 },
    caption,
  );
  if (over === claiming) return;
  claiming = over;
  window.widget.setPointerOverShape(over);
});

// A right-click anywhere on the face dismisses this turn's widget.
window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  perform({ type: "dismiss" });
});

/*
 * Dragging moves the face.
 *
 * The position is reported to the hub so the other faces and the next launch
 * agree about where the user put it — the widget is not the owner of that
 * preference any more than it is the owner of anything else.
 */
let dragging = null;
orbElement.addEventListener("mousedown", (event) => {
  dragging = { x: event.screenX, y: event.screenY, moved: false };
});
window.addEventListener("mousemove", (event) => {
  if (!dragging) return;
  if (wasDrag(dragging, event.screenX, event.screenY)) dragging.moved = true;
});
window.addEventListener("mouseup", (event) => {
  if (!dragging) return;
  const moved = dragging.moved;
  dragging = null;

  // Press and release without travelling is a click, and a click on the orb
  // is the mute. Dragging a widget across the desk must not also mute it,
  // which is what a plain `click` listener beside this one would have done.
  if (moved) perform({ type: "drag", x: event.screenX, y: event.screenY });
  else perform({ type: "mute" });
});

paint();
