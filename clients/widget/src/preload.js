"use strict";
// A sandboxed preload is CommonJS by construction: Electron evaluates it inside
// the renderer sandbox with a `require` shim that resolves only `electron` and
// a handful of built-ins. An `import` statement here is a syntax error at load
// time, and a preload that fails to load leaves the page with no bridge at all
// — which is how this file shipped broken once. CJS is not a style choice; it
// is the only dialect this seam speaks.
const { contextBridge, ipcRenderer } = require("electron");

/**
 * The bridge, carrying as little as a bridge can carry.
 *
 * The renderer needs a few things from the process around it: the port the hub
 * is on, a way to say "the pointer is over me now" so the shell can stop
 * letting clicks fall through, a way to say "I am being dragged", a way to ask
 * for the dashboard, and a way to leave. Everything else it does — the socket,
 * the state, the drawing — it does with the web platform, in a sandbox.
 *
 * What is deliberately absent is the more interesting half of this file. There
 * is no filesystem here, no shell, no ipcRenderer handed over wholesale, and
 * nothing that reaches the daemon. Note what the two new members do *not*
 * carry: the drag reports a distance travelled, never a window position, and
 * the dashboard names no URL. The page describes what the hand did; the shell
 * decides what that means and where anything ends up.
 */
contextBridge.exposeInMainWorld("widget", {
  /** Where the hub listens. Read from the environment, not chosen by the page. */
  hubPort: Number(process.env.COMCON_CLIENT_PORT ?? 4111),

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
