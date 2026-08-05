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
 * The renderer needs three things from the process around it: the port the hub
 * is on, a way to say "the pointer is over me now" so the shell can stop
 * letting clicks fall through, and a way to leave. Everything else it does —
 * the socket, the state, the drawing — it does with the web platform, in a
 * sandbox.
 *
 * What is deliberately absent is the more interesting half of this file. There
 * is no filesystem here, no shell, no ipcRenderer handed over wholesale, and
 * nothing that reaches the daemon. A skin author gets these three things, and
 * a skin that wanted more would find nothing to call.
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
