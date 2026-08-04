import { BrowserWindow, app, ipcMain, screen, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The shell: a window that draws, and a window that is refused everything else.
 *
 * The issue's first ruling is that the widget is a face and never an ear, and
 * this file is where that stops being a promise. Two things enforce it. The
 * renderer runs with no Node integration and a context-isolated bridge that
 * exposes nothing, so the page has no filesystem, no child process, and no way
 * to reach the daemon. And every permission request from this window is denied
 * — not the microphone specifically, all of them.
 *
 * Denying the whole list rather than the microphone is deliberate. A widget
 * that blocked `media` and left `geolocation` open would be one interesting
 * feature away from a leak, and this process has no legitimate use for any
 * permission a browser can grant. The empty allowlist is the honest expression
 * of what a thing that draws needs.
 */

import { HEIGHT, WIDTH, placeWindow } from "./window-shape.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const placement = process.env.COMCON_WIDGET_PLACEMENT ?? "corner";
  const { x, y } = placeWindow(area, placement);

  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x,
    y,
    // Frameless and transparent: the widget is an orb on the desk, not an
    // application window with a title bar and a close button.
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    // On top of the work, because being spoken to should not require finding
    // a window, and out of the taskbar and switcher for the same reason.
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Never steals what the user was typing into. A face that took focus when
    // it appeared would interrupt the very work it is meant to sit beside.
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.js"),
      // The page gets no Node and no shared origin with anything. It is a
      // document that draws; everything below is what that costs to guarantee.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      // No second window may be conjured to run with different rules.
      nativeWindowOpen: false,
    },
  });

  // Floats above full-screen video and other always-on-top windows, which is
  // where a widget that appears when spoken to has to live.
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // The rectangle is mostly transparent, and a transparent pixel that ate a
  // click would have quietly stolen part of the user's desk. The renderer
  // turns this off while the pointer is genuinely over the orb.
  window.setIgnoreMouseEvents(true, { forward: true });

  window.loadFile(path.join(here, "index.html"));
  window.once("ready-to-show", () => window.showInactive());

  return window;
}

function refuseEverything() {
  const widgetSession = session.defaultSession;

  // Asked politely: denied.
  widgetSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  // Checked ahead of asking: also denied, so a feature-detect cannot find an
  // open door that the request handler would have closed.
  widgetSession.setPermissionCheckHandler(() => false);
  // Asked for a specific microphone or camera by a page that got that far:
  // there is nothing to hand back.
  widgetSession.setDevicePermissionHandler(() => false);
  if (typeof widgetSession.setDisplayMediaRequestHandler === "function") {
    // Screen capture is a permission too, and a transparent always-on-top
    // window asking for it would be a keylogger with a nice animation.
    widgetSession.setDisplayMediaRequestHandler((_request, callback) =>
      callback({ video: undefined, audio: undefined }),
    );
  }
}

app.whenReady().then(() => {
  refuseEverything();
  const window = createWindow();

  // The renderer knows what shape it painted; the shell owns the window. While
  // the pointer is over the orb the window takes clicks, and the moment it
  // leaves, clicks fall through to the desk again.
  ipcMain.on("widget:pointer-over-shape", (_event, over) => {
    if (window.isDestroyed()) return;
    window.setIgnoreMouseEvents(!over, { forward: true });
  });
});

// No windows left means no face left, and a face is all this process is.
app.on("window-all-closed", () => app.quit());

// Nothing here opens a second window or navigates anywhere. A widget that
// followed a link would have stopped being a widget.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
});
