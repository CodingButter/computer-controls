import { contextBridge, ipcRenderer } from "electron";

/**
 * The bridge, carrying as little as a bridge can carry.
 *
 * The renderer needs two things from the process around it: the port the hub is
 * on, and a way to say "the pointer is over me now" so the shell can stop
 * letting clicks fall through. Everything else it does — the socket, the state,
 * the drawing — it does with the web platform, in a sandbox.
 *
 * What is deliberately absent is the more interesting half of this file. There
 * is no filesystem here, no shell, no ipcRenderer handed over wholesale, and
 * nothing that reaches the daemon. A skin author gets these two functions, and
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
});
