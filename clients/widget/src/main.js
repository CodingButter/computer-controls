import { BrowserWindow, app, ipcMain, screen, session, shell } from "electron";
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

import {
  dragPlacement,
  readDragRequest,
  stageFor,
} from "./window-shape.js";
import { readPlacement, writePlacement } from "./placement-store.js";
import { dashboardUrl } from "./dashboard.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where the drag is written down, beside whatever else this app stores. */
const placementFile = () => path.join(app.getPath("userData"), "placement.json");

/** The hub's port, read from the environment exactly as the bridge reads it. */
const hubPort = () => Number(process.env.COMCON_CLIENT_PORT ?? 4111);

/**
 * The flag the stage travels on, spelled the same way in the preload.
 *
 * Two files hold this string because they are two dialects — this one is a
 * module and the preload is CommonJS by construction — and a test asserts they
 * agree, so the duplication cannot become a disagreement that shows up as a
 * page that quietly does not know where it is.
 */
const STAGE_ARGUMENT = "--comcon-stage=";

/**
 * Which desk to draw on, and where on it the face starts.
 *
 * Two questions that used to be one. The window covers a display, so the
 * display is chosen first — the one the face was last left on, or the primary
 * one when it has never been left anywhere. Where the orb sits inside that
 * stage is then either the remembered spot, resolved against this display's
 * work area, or the default corner.
 *
 * A remembered spot on a monitor that is no longer plugged in resolves onto a
 * display that is, which is the whole reason the placement is stored as an
 * intention rather than as a pair of pixels.
 */
function openingStage() {
  const stored = readPlacement(placementFile());
  const display = stored
    ? screen.getDisplayNearestPoint({ x: stored.x, y: stored.y })
    : screen.getPrimaryDisplay();
  return stageFor(display, stored ?? process.env.COMCON_WIDGET_PLACEMENT ?? "corner");
}

function createWindow() {
  const stage = openingStage();

  const window = new BrowserWindow({
    // The window is the whole display. It is transparent and click-through, so
    // what the user sees is still an orb in a corner — but the renderer can now
    // draw at any screen position, which is the only way a face can point at
    // something the agent is touching on the other side of the desk.
    width: stage.width,
    height: stage.height,
    x: stage.x,
    y: stage.y,
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
    // Dragging the orb moves the orb, not the window: the window is the desk
    // the orb is drawn on and it stays where the desk is.
    movable: false,
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
      // Where this window is on the desk, handed to the page at load.
      //
      // The renderer has to convert screen coordinates into its own, and a
      // sandboxed page cannot ask which display it is on. An argument is the
      // narrowest way to tell it: it is read once, at startup, and there is no
      // channel here for the page to ask a second question through.
      additionalArguments: [`${STAGE_ARGUMENT}${JSON.stringify(stage)}`],
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

  // The stage travels out with the window because the drag handler needs the
  // same origin the page was given. Two readings of the display could disagree
  // after a monitor changed, and a face drawn against one origin and placed
  // against another is a face in the wrong place for no visible reason.
  return { window, stage };
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
  const { window, stage } = createWindow();

  // The renderer knows what shape it painted; the shell owns the window. While
  // the pointer is over the orb the window takes clicks, and the moment it
  // leaves, clicks fall through to the desk again.
  ipcMain.on("widget:pointer-over-shape", (_event, over) => {
    if (window.isDestroyed()) return;
    window.setIgnoreMouseEvents(!over, { forward: true });
  });

  /*
   * Dragging moves the face, and the shell is the half that can say where.
   *
   * The page reports the distance the pointer has travelled since the press;
   * everything else happens here, where the shape of the desk is actually
   * known. What changed when the window became the stage is only the subject
   * of the arithmetic: the orb moves inside a window that stays where the desk
   * is, rather than the window moving under the compositor. The rule the page
   * lives by did not change at all — it reports travel, never a position,
   * because on a desk with three monitors it has no honest way to know one.
   *
   * The result is handed back in page coordinates, because the page is the
   * thing that draws now. That is the one direction this seam gained, and it
   * carries a place to draw rather than an answer about where the window is.
   *
   * The origin is taken once, at the press, so a long drag accumulates no
   * rounding error and a snap that pulls the orb to an edge does not drag the
   * cursor's frame of reference with it.
   *
   * The write happens on release only. A face persisted on every mousemove
   * would be a JSON file rewritten sixty times a second.
   */
  let orb = stage.orb;
  let dragOrigin = null;
  ipcMain.on("widget:drag", (_event, request) => {
    if (window.isDestroyed()) return;
    const drag = readDragRequest(request);
    if (!drag) return;

    if (drag.phase === "begin") {
      dragOrigin = { x: orb.x, y: orb.y };
      return;
    }
    if (!dragOrigin) return;

    const wanted = { x: dragOrigin.x + drag.dx, y: dragOrigin.y + drag.dy };
    // Clamped and snapped against the display the hand is over, which is not
    // always the display the stage is on — a face dragged towards a second
    // monitor stops at the edge of the desk it is drawn on rather than
    // half-existing on one it cannot reach.
    const display = screen.getDisplayNearestPoint(wanted);
    const placement = dragPlacement(display.workArea, wanted, drag.snap);
    orb = { x: placement.x, y: placement.y };
    window.webContents.send("widget:placed", {
      x: placement.x - stage.x,
      y: placement.y - stage.y,
    });

    if (drag.phase === "end") {
      dragOrigin = null;
      writePlacement(placementFile(), placement);
    }
  });

  // The dashboard opens in the user's browser, not in this process. A widget
  // that rendered a settings page would have become a second application, and
  // this one is a face.
  ipcMain.on("widget:open-dashboard", () => {
    const url = dashboardUrl(hubPort());
    if (url) shell.openExternal(url);
  });

  // A face the user asked to leave leaves. The process closes its own windows
  // and exits — never a kill from outside, always a semantic close.
  ipcMain.on("widget:quit", () => app.quit());
});

// No windows left means no face left, and a face is all this process is.
app.on("window-all-closed", () => app.quit());

// Nothing here opens a second window or navigates anywhere. A widget that
// followed a link would have stopped being a widget.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
});
