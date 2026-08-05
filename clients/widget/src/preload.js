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
 * The renderer needs four things from the process around it: the port the hub
 * is on, the piece of desk this window covers so it can turn the screen
 * coordinates the hub reports into places on its own page, a way to say "the
 * pointer is over me now" so the shell can stop letting clicks fall through,
 * and a way to leave. Everything else it does — the socket, the state, the
 * drawing — it does with the web platform, in a sandbox.
 *
 * What is deliberately absent is the more interesting half of this file. There
 * is no filesystem here, no shell, no ipcRenderer handed over wholesale, and
 * nothing that reaches the daemon. The stage is a measurement handed down, not
 * a way to ask about the desktop: it says how big this window is and where, and
 * there is no call here that could answer a question about anything else on the
 * screen. A skin author gets these four things, and a skin that wanted more
 * would find nothing to call.
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
