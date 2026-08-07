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
import { plugDecision, startEars } from "./ears.js";
import { openMouth } from "./mouth.js";
import { paintCaption, presenceClasses, wasDrag } from "./paint.js";
import { AUTO_HIDE_MS, INITIAL_STATE, applyGesture, fade, keep, reduce } from "./state-machine.js";
import { mountWebGlOrb, syntheticLevel, hasWebGl } from "./face/orb-webgl.js";
import { shaderStateFor } from "./face-state.js";
import { isOverVisibleShape } from "./window-shape.js";

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

/*
 * Where the face is on the desk is not this page's question any more.
 *
 * The window is the face's own box, so the widget fills it and a drag moves the
 * window. That leaves the page with nothing to say about screen coordinates —
 * it does not know where its window is, and on a desk with three monitors it
 * has no honest way to find out.
 */
function paint() {
  root.className = presenceClasses(state).join(" ");
  paintCaption(captionElement, state.caption);
  shaderState = shaderStateFor(state);
  webglOrb?.setState(shaderState);
  reportHitShapes();
}

/*
 * Tell the shell what is touchable right now.
 *
 * On Linux the shell cannot forward mouse events through an ignoring window,
 * so it polls the cursor itself — against these shapes. They are re-reported
 * after every paint because a paint is the only time they can change, and
 * deduplicated so a face repainting the same frame is not a message stream.
 * A face that is not visible reports null: an invisible orb claiming a click
 * would be the transparent window quietly stealing part of the user's desk.
 *
 * The open menu is one of the shapes. It is drawn outside the orb, so a shell
 * polling only the circle would let the pointer leave the orb on its way to
 * "Quit" and take the menu with it.
 */
let lastHitShapes = "";
function reportHitShapes() {
  let shapes = null;
  if (state.presence === "visible") {
    const orb = orbElement.getBoundingClientRect();
    const rects = [];
    if (state.caption) rects.push(boxOf(captionElement));
    if (menuVisible) rects.push(boxOf(menuElement));
    shapes = {
      orb: { cx: orb.left + orb.width / 2, cy: orb.top + orb.height / 2, radius: orb.width / 2 },
      rects,
    };
  }
  const said = JSON.stringify(shapes);
  if (said === lastHitShapes) return;
  lastHitShapes = said;
  window.widget.setHitShapes(shapes);
}

/**
 * An element's box in this window's coordinates, which is what the shell wants.
 *
 * @param {Element} element
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function boxOf(element) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

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
  if (!autoHide) return;
  if (state.presence !== "visible") return;
  fadeTimer = setTimeout(() => {
    state = fade(state, autoHide);
    paint();
  }, AUTO_HIDE_MS);
}

window.widget.onTrayState?.((next) => {
  autoHide = next.autoHide;
  // Disable is the honest off: the ears die with the pixels, and the tray
  // icon is what says so. Enable brings them back without a restart.
  if (next.disabled) stopEars();
  else {
    void startListening();
    // Auto-hide off is a request to see the face, not just a promise to stop
    // hiding it. This is the same transition at a flip and at startup — the
    // shell tells the page the stored setting once the page is loaded, so a
    // widget launched with the setting already off opens with a face up.
    state = keep(state, autoHide);
  }
  paint();
  rewindFade();
});

// Whether the lane is up right now — the mouth checks before promising the
// model an answer, because a promise made over a dead lane is an answer the
// user waits for forever.
let hubConnected = false;

const hub = connectToHub({
  port: window.widget.hubPort,
  onConnectionChange: (connected) => {
    hubConnected = connected;
    // A lane that dies takes the mouth with it: a session without the lane
    // could still chat with the model but could never reach the hub.
    if (!connected && mouth) closeMouth();
  },
  onEvent: (event) => {
    state = reduce(state, event);
    paint();
    rewindFade();
    // The mouth's own asks come back over the same socket the face watches.
    mouth?.deliver(event);
    // The arbitration Jamie named: another client's voice session plugs
    // these ears; its close unplugs them.
    const decision = plugDecision(event.type, mouthOpen);
    if (decision === "plug") ears?.plug();
    if (decision === "unplug") ears?.unplug();
  },
});

/*
 * The ears and the mouth.
 *
 * The gate runs the hub's own wake chain against this page's microphone; the
 * mouth opens when the gate does and closes when the gate goes quiet. The
 * face is popped locally on wake rather than waiting for the hub to say
 * something — the orb must be visible whenever it is listening, because it
 * is the one indicator that things aren't frozen.
 */
let ears = null;
let mouth = null;
let mouthOpen = false;

async function startListening() {
  if (ears) return;
  try {
    ears = await startEars({
      onOpen: (hearing) => {
        mouthOpen = true;
        state = reduce(state, { type: "wake_opened" });
        paint();
        rewindFade();
        void openMouth({
          lane: {
            send: (frame) => hub.send(frame),
            isOpen: () => hubConnected,
          },
          mintToken: () => window.widget.mintToken(),
          transcript: hearing.transcript,
          onCaption: (text) => {
            state = reduce(state, { type: "caption", text });
            paint();
            rewindFade();
          },
          onState: () => rewindFade(),
          onReason: () => closeMouth(),
        }).then(
          (opened) => {
            // The gate may have gone quiet while the dial was in flight; a
            // mouth that arrived after its conversation ended closes now.
            if (!mouthOpen) return void opened.close();
            mouth = opened;
          },
          () => {
            // A refused mint or a failed dial: the face returns to rest.
            // The wake chain is untouched — the next wake tries again.
            mouthOpen = false;
            state = reduce(state, { type: "idle" });
            paint();
            rewindFade();
          },
        );
      },
      onForward: (frame) => mouth?.forward(frame),
      onIdle: () => closeMouth(),
      // The gate's quiet clock does not run while the mouth is playing the
      // model's answer: a user listening in silence is not a user who left.
      hold: () => mouth?.speaking() ?? false,
    });
  } catch {
    // A refused microphone is a widget without ears, not a broken face.
    // Everything else — the lane, the gestures, the scouts — still works.
    ears = null;
  }
}

function closeMouth() {
  mouthOpen = false;
  const closing = mouth;
  mouth = null;
  if (closing) void closing.close();
  state = reduce(state, { type: "idle" });
  paint();
  rewindFade();
}

function stopEars() {
  closeMouth();
  ears?.stop();
  ears = null;
}

/**
 * Do it here, and tell the hub.
 *
 * Both halves are needed and neither is sufficient. Drawing it locally is what
 * makes the widget feel like it responded; telling the hub is what makes it
 * shared truth — the hub is where every other face learns what this one did.
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
 * Hover: the pointer arriving, acknowledged and nothing else.
 *
 * Who owns the click is the shell's question now — it polls the real cursor
 * against the shapes reported above, because a click-through window on Linux
 * receives no pointer events to change its mind with. By the time this handler
 * runs the shell has already claimed the pointer, so the same hit-test is asked
 * again here for one purpose: the orb looks touchable while the hand is on it.
 * No gesture, no message, no record that the pointer was ever there.
 */
window.addEventListener("mousemove", (event) => {
  if (menuVisible || dragging) return;
  const orb = orbElement.getBoundingClientRect();
  const over = isOverVisibleShape(
    { x: event.clientX, y: event.clientY },
    {
      orb: { cx: orb.left + orb.width / 2, cy: orb.top + orb.height / 2, radius: orb.width / 2 },
      rects: state.caption ? [boxOf(captionElement)] : [],
    },
  );
  orbElement.classList.toggle("hovered", over);
});

/*
 * The menu: the one way out of a face that has no frame, no taskbar entry, and
 * never takes focus.
 *
 * Right-click opens it where the pointer is. Opening and closing it re-reports
 * the hit shapes, because the menu is one of them: while it is open the shell
 * keeps claiming clicks over it, so the buttons stay clickable, and once it is
 * gone those pixels fall through to the desk again. The three items are the
 * three things the face can do that are not gestures: show the user the
 * dashboard, go away for this turn, or go away for good.
 */
let menuVisible = false;

/** @param {number} x @param {number} y */
function showMenu(x, y) {
  menuElement.style.left = `${x}px`;
  menuElement.style.top = `${y}px`;
  menuElement.hidden = false;
  menuVisible = true;
  reportHitShapes();
}

function hideMenu() {
  menuElement.hidden = true;
  menuVisible = false;
  reportHitShapes();
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
 * Dragging moves the face — which now means it moves this window.
 *
 * The page reports a distance travelled since the press and nothing else,
 * because it has no idea where its own window sits on the desk. The shell does
 * the arithmetic, clamps against whichever display the hand is over, and calls
 * `setPosition`; the window moving is the whole answer, and this page learns it
 * the same way the user does. Nothing comes back, so there is no local preview
 * that a snap could briefly disagree with.
 *
 * Where the face sits is not told to the hub. It is a property of a window on
 * one person's desk, kept by the shell in the placement file, and a screen
 * coordinate is not something this page could report honestly anyway.
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
