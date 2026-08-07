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
  readDragRequest,
  stageFor,
} from "./window-shape.js";
import { readPlacement, writePlacement } from "./placement-store.js";
import { readTrayState, writeTrayState } from "./tray-state.js";
import { createTray } from "./tray.js";
import { dashboardUrl } from "./dashboard.js";
import { readWakeTemplates, writeWakeTemplates } from "./wake-templates.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where the drag is written down, beside whatever else this app stores. */
const placementFile = () => path.join(app.getPath("userData"), "placement.json");

/** Where the tray's choices are written down, beside the placement. */
const trayStateFile = () => path.join(app.getPath("userData"), "tray-state.json");

/** Where the enrolled wake-word templates live, beside the tray state. */
const wakeTemplatesFile = () => path.join(app.getPath("userData"), "wake-templates.json");

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

function createWindow({ startHidden = false } = {}) {
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
  // A widget the user disabled last run comes back disabled: loaded and
  // wired, so enabling it later is instant, but never shown.
  window.once("ready-to-show", () => {
    if (!startHidden) window.showInactive();
  });

  // The stage travels out with the window because the drag handler needs the
  // same origin the page was given. Two readings of the display could disagree
  // after a monitor changed, and a face drawn against one origin and placed
  // against another is a face in the wrong place for no visible reason.
  return { window, stage };
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

  const { window, stage } = createWindow({ startHidden: trayState.disabled });

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
    tuneWakeWord: () => {
      // The tray asked, so the page does the recording — it is the one document
      // with a microphone. A disabled widget has no ears, so the enrollment
      // surface is only reachable while enabled.
      if (!window.isDestroyed() && !trayState.disabled) {
        window.webContents.send("widget:start-enrollment");
      }
    },
    quit: () => app.quit(),
  });

  // The renderer hears the current choices once it is ready to hear anything.
  window.webContents.on("did-finish-load", () => {
    window.webContents.send("widget:tray-state", {
      autoHide: trayState.autoHide,
      disabled: trayState.disabled,
    });
    // First launch after install: if no wake-word templates have been enrolled
    // yet, invite the user to tune the fingerprint to their own voice. A
    // disabled widget never gets the prompt — it has no microphone.
    if (!trayState.disabled && !readWakeTemplates(wakeTemplatesFile()).enrolled) {
      window.webContents.send("widget:start-enrollment");
    }
  });

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
  ipcMain.on("widget:open-dashboard", openDashboard);

  /*
   * Enrolled templates come from the page and land on disk here. The page owns
   * the recording and the scoring; the main process owns the filesystem, and
   * the bridge is deliberately fire-and-forget — the page already has the
   * templates in memory for this session, so it does not wait on the write.
   */
  ipcMain.on("widget:write-wake-templates", (_event, state) => {
    writeWakeTemplates(wakeTemplatesFile(), state);
  });

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
