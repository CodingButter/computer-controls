"use strict";
// A sandboxed preload is CommonJS by construction: Electron evaluates it inside
// the renderer sandbox with a `require` shim that resolves only `electron` and
// a handful of built-ins. An `import` statement here is a syntax error at load
// time, and a preload that fails to load leaves the page with no bridge at all
// — which is how this file shipped broken once. CJS is not a style choice; it
// is the only dialect this seam speaks.
const { contextBridge, ipcRenderer } = require("electron");

/** The flag the shell puts the stage on. Spelled the same way in main.js. */
const STAGE_ARGUMENT = "--comcon-stage=";

/**
 * Which piece of desk this window covers, as the shell measured it.
 *
 * Read from the process arguments rather than asked for, because asking would
 * mean a channel the page could ask other things through. It arrives once, at
 * load, and a page that cannot parse it is a page that draws its orb at the
 * top-left and points at nothing — wrong, but wrong in a way that does not
 * invent positions.
 *
 * @returns {{ x: number, y: number, width: number, height: number, orb: { x: number, y: number } } | null}
 */
function readStage() {
  const flag = process.argv.find((argument) => argument.startsWith(STAGE_ARGUMENT));
  if (!flag) return null;
  try {
    return JSON.parse(flag.slice(STAGE_ARGUMENT.length));
  } catch {
    return null;
  }
}

/**
 * The bridge, carrying as little as a bridge can carry.
 *
 * The renderer needs a handful of things from the process around it: the port
 * the hub is on, the piece of desk this window covers so it can turn the screen
 * coordinates the hub reports into places on its own page, a way to say "the
 * pointer is over me now" so the shell can stop letting clicks fall through, a
 * way to say "I am being dragged", somewhere to hear where that drag landed, a
 * way to ask for the dashboard, and a way to leave. Everything else it does —
 * the socket, the state, the drawing — it does with the web platform, in a
 * sandbox.
 *
 * What is deliberately absent is the more interesting half of this file. There
 * is no filesystem here, no shell, no ipcRenderer handed over wholesale, and
 * nothing that reaches the daemon. The stage is a measurement handed down, not
 * a way to ask about the desktop: it says how big this window is and where, and
 * there is no call here that could answer a question about anything else on the
 * screen. Note what the drag members do *not* carry: the page reports a
 * distance travelled and is told a place to draw, and neither direction ever
 * names the window's own position — which the page has no honest way to know
 * and no reason to. The dashboard names no URL. A skin author gets these
 * things, and a skin that wanted more would find nothing to call.
 */
contextBridge.exposeInMainWorld("widget", {
  /** Where the hub listens. Read from the environment, not chosen by the page. */
  hubPort: Number(process.env.COMCON_CLIENT_PORT ?? 4111),

  /** The display this window covers, in screen coordinates. Null if unstated. */
  stage: readStage(),

  /**
   * Whether the pointer is currently over something the widget drew.
   *
   * The renderer knows the shape it painted; the shell owns the window. This
   * is the one thing that has to cross between them.
   *
   * @param {boolean} over
   */
  setPointerOverShape(over) {
    ipcRenderer.send("widget:pointer-over-shape", Boolean(over));
  },

  /**
   * The hand moved the face.
   *
   * Reported as a distance from where the press started, not as a place to put
   * the window: the page does not know where its own window is on a desk with
   * three monitors, and the shell does. `snap` is simply whether shift is
   * down — which edge that means, if any, is the shell's arithmetic.
   *
   * @param {"begin" | "move" | "end"} phase
   * @param {number} dx
   * @param {number} dy
   * @param {boolean} snap
   */
  drag(phase, dx, dy, snap) {
    ipcRenderer.send("widget:drag", {
      phase: String(phase),
      dx: Number(dx),
      dy: Number(dy),
      snap: Boolean(snap),
    });
  },

  /**
   * Where the face ended up, in this page's own coordinates.
   *
   * The counterpart to `drag`, and the piece the stage made necessary: when the
   * window moved, the page never had to learn the result, because the result
   * *was* the window moving. Now the window is the whole display and the orb
   * moves inside it, so the shell does the snapping and the clamping and hands
   * back a place to draw.
   *
   * Page coordinates, not screen coordinates — the stage origin is subtracted
   * before it crosses, so this member cannot become a way to ask where the
   * window is.
   *
   * @param {(placement: { x: number, y: number }) => void} listener
   */
  onPlaced(listener) {
    ipcRenderer.on("widget:placed", (_event, placement) => {
      listener({ x: Number(placement?.x), y: Number(placement?.y) });
    });
  },

  /**
   * How the user set the tray, told to the page whenever it changes.
   *
   * Receive-only, and carrying two booleans: whether the face may hide
   * itself after a quiet while, and whether the widget is disabled. The page
   * is told so it can run the auto-hide timer against the events it already
   * watches — there is no member here to change either value, because tray
   * control never crosses this bridge. A page that could disable its own
   * indicator would defeat the indicator.
   *
   * @param {(state: { autoHide: boolean, disabled: boolean }) => void} listener
   */
  onTrayState(listener) {
    ipcRenderer.on("widget:tray-state", (_event, state) => {
      listener({ autoHide: Boolean(state?.autoHide), disabled: Boolean(state?.disabled) });
    });
  },

  /**
   * A short-lived, constrained token for dialing Google directly.
   *
   * The renderer never learns the hub's port twice: the lane's address lives
   * in `hubPort`, and this is the only other thing the page ever needs from
   * the hub, so it rides main. What comes back is either the picked fields of
   * a minted token or the hub's refusal sentence verbatim — never a stored
   * credential, because main never sees one either; the mint's whole design
   * is that the key stays home.
   *
   * @returns {Promise<{ token?: string, model?: string, expiresAt?: string, error?: string }>}
   */
  mintToken() {
    return ipcRenderer.invoke("widget:mint-token");
  },

  /**
   * Show me the dashboard.
   *
   * No URL crosses this seam. The renderer asks for the one page the shell
   * knows how to open, and the shell builds the loopback address itself — a
   * bridge that took a link from the page would make an always-on-top window
   * into a way to open anything at all.
   */
  openDashboard() {
    ipcRenderer.send("widget:open-dashboard");
  },

  /**
   * The wake-word templates this machine listens for.
   *
   * Shapes, never audio, and never a recording made here — the widget has no
   * enrollment surface. The shell fetches them from the hub, which owns the
   * one voice print every listening surface compares against.
   *
   * @returns {Promise<{ templates: unknown[] }>}
   */
  wakeTemplates() {
    return ipcRenderer.invoke("widget:wake-templates");
  },

  /**
   * The hub asked what the face looks like; pass the id along.
   *
   * Send-only, and the id is all that crosses. The page cannot take a picture
   * — it has no capture API and the boundary tests keep it that way — and it
   * learns nothing from this call either: there is no return value, so a skin
   * that called it in a loop would get pixels it never sees, sent to a hub
   * that only hands them to whoever asked over loopback.
   *
   * @param {string} id
   */
  capture(id) {
    ipcRenderer.send("widget:capture", String(id));
  },

  /**
   * End this process.
   *
   * Quit is a process-level action, not a conversation gesture. It does not
   * travel the socket, because the hub does not own this process's lifetime;
   * the shell closes its own windows, which is a clean exit — never a kill
   * from outside.
   */
  quit() {
    ipcRenderer.send("widget:quit");
  },
});
