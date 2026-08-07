import { BrowserWindow, app, ipcMain, screen, session, shell } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The shell: a window that draws and listens, and is refused everything else.
 *
 * The widget grew ears, and this file is where the boundary of that stops
 * being a promise. The permission surface is a scalpel, not a door: exactly
 * one permission — `media`, audio only — for exactly one document, the
 * widget's own page, and only while the tray has not disabled the widget.
 * Everything else on the list is denied the way it always was, and display
 * capture is refused in every handler permanently, because a transparent
 * always-on-top window that could see the screen would be a keylogger with
 * a nice animation.
 *
 * Denying by default and carving one named hole is deliberate. A widget that
 * granted `media` broadly would hand its microphone to any document that
 * ever rendered in this session; naming the page makes the grant an identity
 * check, not a category.
 */

import {
  dragPlacement,
  isOverVisibleShape,
  openingPlacement,
  readDragRequest,
  readHitShapes,
} from "./window-shape.js";
import { readPlacement, writePlacement } from "./placement-store.js";
import { readTrayState, writeTrayState } from "./tray-state.js";
import { createTray } from "./tray.js";
import { dashboardUrl } from "./dashboard.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where the drag is written down, beside whatever else this app stores. */
const placementFile = () => path.join(app.getPath("userData"), "placement.json");

/** Where the tray's choices are written down, beside the placement. */
const trayStateFile = () => path.join(app.getPath("userData"), "tray-state.json");

/** The hub's port, read from the environment exactly as the bridge reads it. */
const hubPort = () => Number(process.env.COMCON_CLIENT_PORT ?? 4111);

/**
 * How often the shell asks where the cursor is, in milliseconds.
 *
 * About thirty times a second: fast enough that the orb feels like it is
 * waiting for the pointer rather than catching up with it, slow enough that
 * an idle desk is not paying for a face nobody is reaching for. It only runs
 * while something is actually drawn.
 */
const CURSOR_POLL_MS = 33;

/**
 * Where the face opens: the orb's own box, on the display it was left on.
 *
 * The display is chosen first — the one the face was last left on, or the
 * primary one when it has never been left anywhere — and the spot on it is
 * either the remembered placement, resolved against that display's work area,
 * or the default corner.
 *
 * A remembered spot on a monitor that is no longer plugged in resolves onto a
 * display that is, which is the whole reason the placement is stored as an
 * intention rather than as a pair of pixels.
 */
function openingBounds() {
  const stored = readPlacement(placementFile());
  const display = stored
    ? screen.getDisplayNearestPoint({ x: stored.x, y: stored.y })
    : screen.getPrimaryDisplay();
  return openingPlacement(display, stored ?? process.env.COMCON_WIDGET_PLACEMENT ?? "corner");
}

function createWindow({ startHidden = false } = {}) {
  const bounds = openingBounds();

  const window = new BrowserWindow({
    // The window is the face: the orb's own box, put where the orb goes and
    // carried there by the drag. It used to be the whole display — a sheet the
    // orb was drawn somewhere inside — which is exactly why the face could
    // never leave the monitor it opened on.
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
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
    // Dragging the orb moves this window, so the window has to be movable.
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Focusable, and the tradeoff is deliberate.
    //
    // This was `false`, to guarantee the face never steals what the user is
    // typing into. On X11 that flag does not mean "do not take focus": Electron
    // implements an unfocusable window as an override-redirect one, which tells
    // the window manager not to manage it at all. An unmanaged window has no
    // `_NET_WM_STATE_ABOVE` and no place in `_NET_CLIENT_LIST_STACKING`, so
    // `alwaysOnTop` above is silently discarded and the orb's visibility
    // becomes raw stacking luck — one raised window away from buried.
    //
    // The two cannot coexist there, so the flag goes and the guarantee stays:
    // this shell only ever calls `showInactive()`, never `show()` and never
    // `focus()`, so the face still never takes focus by appearing. What is
    // given up is that clicking the orb can now focus it — a deliberate act by
    // the user, on a window they just clicked, which is what every other
    // window on the desk does.
    focusable: true,
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

  // Click-through until something drawn is under the pointer. The shell turns
  // this off while the cursor is genuinely over the orb; see the poll below.
  window.setIgnoreMouseEvents(true);

  window.loadFile(path.join(here, "index.html"));
  // A widget the user disabled last run comes back disabled: loaded and
  // wired, so enabling it later is instant, but never shown.
  window.once("ready-to-show", () => {
    if (!startHidden) window.showInactive();
  });

  return window;
}

/** The one document the microphone may be granted to: the widget's own page. */
const widgetPageUrl = () => pathToFileURL(path.join(here, "index.html")).href;

/**
 * Deny everything, then carve exactly one hole.
 *
 * @param {() => boolean} isDisabled — the tray's word on whether the ears are
 *   allowed to exist right now. Read at decision time, not captured at setup,
 *   so flipping the tray switch changes the answer without a restart.
 */
function guardPermissions(isDisabled) {
  const widgetSession = session.defaultSession;

  // The carve-out, applied identically to the ask and the feature-detect: the
  // microphone (audio only, never video), for the widget's own page, while
  // the widget is enabled. Anything that misses any clause is denied.
  const micForOwnPage = (permission, requestingUrl, mediaTypes) => {
    if (isDisabled()) return false;
    if (permission !== "media") return false;
    if (requestingUrl !== widgetPageUrl()) return false;
    // Audio and nothing else. A request that also wants video is refused
    // whole rather than trimmed: a caller asking for more than the design
    // grants is a caller this handler does not negotiate with.
    return mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");
  };

  // Asked politely: the one carve-out, else denied.
  widgetSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(micForOwnPage(permission, details.requestingUrl, details.mediaTypes ?? []));
  });
  // Checked ahead of asking: the same answer, so a feature-detect can never
  // find a door the request handler would have closed — or miss the one it
  // would have opened.
  widgetSession.setPermissionCheckHandler((_contents, permission, _origin, details) =>
    micForOwnPage(permission, details.requestingUrl, details.mediaType ? [details.mediaType] : []),
  );
  // Asked for a specific device by id: there is still nothing to hand back.
  // getUserMedia with the carve-out above reaches the default microphone;
  // enumerating and claiming particular hardware is not a thing a face does.
  widgetSession.setDevicePermissionHandler(() => false);
  if (typeof widgetSession.setDisplayMediaRequestHandler === "function") {
    // Screen capture is refused permanently, in every state, disabled or not.
    // The ears carve-out changes nothing here and never will.
    widgetSession.setDisplayMediaRequestHandler((_request, callback) =>
      callback({ video: undefined, audio: undefined }),
    );
  }
}

app.whenReady().then(() => {
  // How the user left things, restored before anything is drawn: a widget
  // disabled last run starts disabled, not visible-for-a-frame.
  let trayState = readTrayState(trayStateFile());

  guardPermissions(() => trayState.disabled);

  const window = createWindow({ startHidden: trayState.disabled });

  // The one page this process opens, shared by the tray menu and the face's
  // own context menu. The address is built here, in the main process, from a
  // constant host and the environment's port — never taken from a page or a
  // menu item.
  const openDashboard = () => {
    const url = dashboardUrl(hubPort());
    if (url) shell.openExternal(url);
  };

  /**
   * A tray choice landed: remember it, redraw the icon, and apply it.
   *
   * Written on every change — a choice that only persisted on clean exit
   * would be lost to every crash — and told to the renderer, which owns the
   * auto-hide timer because it is the process that sees the lane's events.
   * The renderer is told, never asked: tray control stays on this side of
   * the bridge, because a page that could disable its own indicator would
   * defeat the indicator.
   *
   * @param {import("./tray-state.js").TrayState} next
   */
  const applyTrayState = (next) => {
    const wasDisabled = trayState.disabled;
    trayState = next;
    writeTrayState(trayStateFile(), trayState);
    trayControls.refresh(trayState);
    if (window.isDestroyed()) return;
    if (trayState.disabled !== wasDisabled) {
      // Disable is the honest off: the whole face leaves, and the tray icon
      // is what says so. Enable brings it back without stealing focus.
      if (trayState.disabled) window.hide();
      else window.showInactive();
    }
    window.webContents.send("widget:tray-state", {
      autoHide: trayState.autoHide,
      disabled: trayState.disabled,
    });
  };

  const trayControls = createTray(trayState, {
    toggleAutoHide: () => applyTrayState({ ...trayState, autoHide: !trayState.autoHide }),
    toggleDisabled: () => applyTrayState({ ...trayState, disabled: !trayState.disabled }),
    openDashboard,
    quit: () => app.quit(),
  });

  // The renderer hears the current choices once it is ready to hear anything.
  window.webContents.on("did-finish-load", () => {
    window.webContents.send("widget:tray-state", {
      autoHide: trayState.autoHide,
      disabled: trayState.disabled,
    });
  });

  /*
   * Dragging moves the window, and the shell is the half that can say where.
   *
   * The page reports the distance the pointer has travelled since the press;
   * everything else happens here, where the shape of the desk is actually
   * known. The page reports travel and never a position, because on a desk
   * with three monitors it has no honest way to know one — and it does not
   * need one, because the answer is not drawn, it is `setPosition`.
   *
   * The origin is taken once, at the press, so a long drag accumulates no
   * rounding error and a snap that pulls the face to an edge does not drag the
   * cursor's frame of reference with it.
   *
   * The clamp follows the pointer's display rather than the window's, which is
   * what lets the face cross onto a second monitor: the desk it is being taken
   * to is the one that decides where the edges are.
   *
   * The write happens on release only. A face persisted on every mousemove
   * would be a JSON file rewritten sixty times a second.
   */
  let dragOrigin = null;
  ipcMain.on("widget:drag", (_event, request) => {
    if (window.isDestroyed()) return;
    const drag = readDragRequest(request);
    if (!drag) return;

    if (drag.phase === "begin") {
      const bounds = window.getBounds();
      dragOrigin = { x: bounds.x, y: bounds.y };
      return;
    }
    if (!dragOrigin) return;

    const wanted = { x: dragOrigin.x + drag.dx, y: dragOrigin.y + drag.dy };
    const display = screen.getDisplayNearestPoint(wanted);
    const placement = dragPlacement(display.workArea, wanted, drag.snap);
    window.setPosition(placement.x, placement.y);

    if (drag.phase === "end") {
      dragOrigin = null;
      writePlacement(placementFile(), placement);
    }
  });

  /*
   * Click-through, and the poll that is the only honest way to leave it.
   *
   * The window is mostly transparent — a rounded orb and sometimes a line of
   * text inside a rectangle — and a transparent pixel that ate a click would
   * quietly steal part of the user's desk. So the window ignores mouse events
   * by default and claims them only while the pointer is genuinely over
   * something drawn.
   *
   * Deciding that here, rather than letting the page say so, is forced by the
   * platform. `setIgnoreMouseEvents(true, { forward: true })` — asking for the
   * events to be forwarded to the page anyway, so it can notice the pointer
   * arriving and change its mind — does nothing on Linux. An ignoring window
   * there receives no pointer events at all, which means a page that had gone
   * click-through could never be the thing that reports the pointer coming
   * back. The shell asks the compositor where the cursor is instead.
   *
   * The page still owns the shapes, because the page is what drew them: it
   * reports them in window coordinates whenever they change, and `null` when
   * there is nothing on screen to claim. Nothing drawn means nothing to poll,
   * so the timer stops — an invisible face costs no cursor lookups.
   *
   * A drag in flight suspends the question entirely. The window is being moved
   * under the pointer on purpose, and a clamp at the edge of a display can
   * leave the cursor outside the orb for a frame; releasing the claim there
   * would drop the gesture the user is still making.
   */
  let hitShapes = null;
  let cursorPoll = null;

  const stopPolling = () => {
    if (cursorPoll) clearInterval(cursorPoll);
    cursorPoll = null;
  };

  const followCursor = () => {
    if (window.isDestroyed()) return stopPolling();
    if (!hitShapes || dragOrigin) return;
    const cursor = screen.getCursorScreenPoint();
    const origin = window.getBounds();
    const over = isOverVisibleShape(
      { x: cursor.x - origin.x, y: cursor.y - origin.y },
      hitShapes,
    );
    window.setIgnoreMouseEvents(!over);
  };

  ipcMain.on("widget:hit-shapes", (_event, shapes) => {
    if (window.isDestroyed()) return;
    hitShapes = readHitShapes(shapes);
    if (!hitShapes) {
      stopPolling();
      window.setIgnoreMouseEvents(true);
      return;
    }
    if (!cursorPoll) cursorPoll = setInterval(followCursor, CURSOR_POLL_MS);
    followCursor();
  });

  window.on("closed", stopPolling);

  // The dashboard opens in the user's browser, not in this process. A widget
  // that rendered a settings page would have become a second application, and
  // this one is a face.
  ipcMain.on("widget:open-dashboard", openDashboard);

  /*
   * The token mint rides main: the renderer never learns the hub's port twice.
   *
   * The page already reaches the hub once, through the bridge's hubPort and
   * the lane; giving it an HTTP client aimed at the same address would be a
   * second copy of the same knowledge, and the copy is where drift starts.
   * Main asks the mint and hands back exactly the fields the page needs — the
   * hub's refusal sentences travel verbatim, because they are page states,
   * not errors. Nothing here is logged: a token in a log file is a token.
   */
  ipcMain.handle("widget:mint-token", async () => {
    if (trayState.disabled) {
      return { error: "The widget is disabled, so no token was requested." };
    }
    try {
      const response = await fetch(`http://127.0.0.1:${hubPort()}/api/orb/token`, {
        method: "POST",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { error: body.error ?? `The token mint refused with status ${response.status}.` };
      }
      return { token: body.token, model: body.model, expiresAt: body.expiresAt };
    } catch {
      return { error: "The hub could not be reached, so no token was minted." };
    }
  });

  // A face the user asked to leave leaves. The process closes its own windows
  // and exits — never a kill from outside, always a semantic close.
  ipcMain.on("widget:quit", () => app.quit());
});

// A closed window is not a closed application any more: the tray owns the
// lifetime, and quit lives in its menu. This listener existing is what stops
// Electron's default exit — deliberately empty, not forgotten.
app.on("window-all-closed", () => {});

// Nothing here opens a second window or navigates anywhere. A widget that
// followed a link would have stopped being a widget.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
});
