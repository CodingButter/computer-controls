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
 * The renderer needs a handful of things from the process around it: the port
 * the hub is on, a way to say what shapes it has drawn so the shell knows when
 * clicks stop falling through, a way to say "I am being dragged", a way to ask
 * for the dashboard, and a way to leave. Everything else it does — the socket,
 * the state, the drawing — it does with the web platform, in a sandbox.
 *
 * What is deliberately absent is the more interesting half of this file. There
 * is no filesystem here, no shell, no ipcRenderer handed over wholesale, and
 * nothing that reaches the daemon. Nothing here answers a question about the
 * desktop: the page reports what it drew and how far a hand has moved, both in
 * its own coordinates, and is told nothing back about where its window is —
 * which it has no honest way to know on a desk with three monitors, and no
 * reason to. The dashboard names no URL. A skin author gets these things, and a
 * skin that wanted more would find nothing to call.
 */
contextBridge.exposeInMainWorld("widget", {
  /** Where the hub listens. Read from the environment, not chosen by the page. */
  hubPort: Number(process.env.COMCON_CLIENT_PORT ?? 4111),

  /**
   * What the widget currently has on screen, in this window's coordinates.
   *
   * The renderer knows the shapes it painted; the shell owns the window and is
   * the only half that can see the real cursor. Sent whenever the shapes
   * change, and `null` when there is nothing drawn at all — which the shell
   * reads as "let every click through".
   *
   * @param {{ orb: { cx: number, cy: number, radius: number } | null, rects: { x: number, y: number, width: number, height: number }[] } | null} shapes
   */
  setHitShapes(shapes) {
    ipcRenderer.send("widget:hit-shapes", shapes);
  },

  /**
   * The hand moved the face.
   *
   * Reported as a distance from where the press started, not as a place to put
   * the window: the page does not know where its own window is on a desk with
   * three monitors, and the shell does. `snap` is simply whether shift is
   * down — which edge that means, if any, is the shell's arithmetic.
   *
   * Nothing comes back. The window moving *is* the answer, and the page sees
   * that the same way the user does.
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
