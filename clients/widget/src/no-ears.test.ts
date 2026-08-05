import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// The shell's manners, importable without starting Electron. `main.js` itself
// is read as text below rather than imported, because importing it would mean
// this suite could only run on a machine with a display.
import { GRANTED_PERMISSIONS, HEIGHT, placeOrb, stageFor } from "./window-shape.js";
import { hubEventsUrl, nextRetryDelay } from "./connection.js";
import { dashboardUrl } from "./dashboard.js";

/**
 * The widget is a face, never an ear — checked against the code that ships.
 *
 * This is a source-level test on purpose, and the reasoning is worth stating.
 * The claim is not "the widget did not use a microphone during this test run",
 * which is what a runtime assertion would give and which says nothing about the
 * path a test happened not to take. The claim is that there is no microphone in
 * this process at all: no call that opens one, no permission that would allow
 * one, and no socket that could carry what one heard. That is a property of the
 * text of the program, so the text is what is read.
 *
 * It also holds up where a runtime test could not run at all. The widget is an
 * Electron window and this suite runs on machines with no display.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** Every module that ships inside the widget process. */
const shipped = readdirSync(SRC)
  .filter((name) => /\.(js|html)$/.test(name))
  .sort();

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const allSource = shipped.map(read).join("\n");

/**
 * The face ships too, and the scan above does not reach it.
 *
 * `shipped` is a flat read of src/, so everything under src/face/ — the shader
 * the widget actually draws with, and the three.js it draws through — falls
 * outside it. That placement is deliberate and load-bearing: three.module.js
 * carries audio-path source the widget never invokes, and a flat scan would
 * read those dead strings as an ear.
 *
 * The exemption stops at the vendored library. `orb-webgl.js` is this
 * project's own code, it runs in the same renderer as everything else, and it
 * gets read by the same list. three.module.js is held honest a different way:
 * face-parity.test.ts pins it byte-for-byte to the hub's copy, so it cannot
 * acquire anything here that it did not have there.
 */
const face = read("face/orb-webgl.js");

test("test_the_widget_process_holds_no_microphone_access", () => {
  // The suite is reading real files, not an empty directory that would make
  // every assertion below vacuously true.
  expect(shipped).toContain("main.js");
  expect(shipped).toContain("renderer.js");
  expect(shipped).toContain("preload.js");
  expect(shipped.length).toBeGreaterThan(4);

  // Nothing anywhere in the process opens a capture device.
  const waysToOpenAnEar = [
    "getUserMedia",
    "mediaDevices",
    "MediaRecorder",
    "AudioContext",
    "createMediaStreamSource",
    "getDisplayMedia",
    "desktopCapturer",
    "AudioWorklet",
    "webkitAudioContext",
    "navigator.permissions",
  ];
  for (const call of waysToOpenAnEar) {
    expect(allSource, `the widget must not reach for ${call}`).not.toContain(call);
    expect(face, `the face must not reach for ${call}`).not.toContain(call);
  }

  // three.js can open an ear of its own — an AudioListener is a WebAudio
  // context wearing a scene-graph hat. Nothing the widget draws with may name
  // one, which is what keeps the vendored library's audio path dead rather
  // than merely unused today.
  for (const audio of ["AudioListener", "PositionalAudio", "AudioAnalyser", "AudioLoader"]) {
    expect(allSource, `the widget must not construct three's ${audio}`).not.toContain(audio);
    expect(face, `the face must not construct three's ${audio}`).not.toContain(audio);
  }

  // Nor does it hold a permission that would let it. The list is empty, and
  // the handlers below are what make the emptiness enforced rather than
  // merely declared.
  expect(GRANTED_PERMISSIONS).toHaveLength(0);

  const main = read("main.js");
  // Asked politely, and checked ahead of asking: both are refused, so a
  // feature-detect cannot find a door the request handler would have closed.
  expect(main).toContain("setPermissionRequestHandler");
  expect(main).toContain("callback(false)");
  expect(main).toContain("setPermissionCheckHandler");
  expect(main).toContain("setDevicePermissionHandler");

  // The renderer is a document. Node inside it would be a way around every
  // line above, since a page with `require` does not need a permission to
  // read a device.
  expect(main).toContain("nodeIntegration: false");
  expect(main).toContain("contextIsolation: true");
  expect(main).toContain("sandbox: true");
});

test("test_idle_audio_never_leaves_the_machine_with_the_widget_running", () => {
  // The hub's half of this is proved at its socket: nothing it sends is audio,
  // and binary frames coming the other way are dropped unread. This is the
  // widget's half — that there is no second connection, to anywhere, over
  // which anything at all could leave.

  // Two addresses are built in this process, and both are loopback: the socket
  // the face listens on, and the dashboard the shell hands to a browser. Only
  // the port varies in either, and a port does not change which machine the
  // traffic reaches.
  expect(hubEventsUrl(4111)).toBe("ws://127.0.0.1:4111/events");
  expect(hubEventsUrl(9999)).toContain("127.0.0.1");
  expect(dashboardUrl(4111)).toBe("http://127.0.0.1:4111/");
  expect(dashboardUrl(9999)).toContain("http://127.0.0.1:");
  // A port that is not a port opens nothing at all, rather than an address
  // assembled out of whatever was in the environment.
  for (const notAPort of [Number.NaN, 0, -1, 70000, 4111.5]) {
    expect(dashboardUrl(notAPort), String(notAPort)).toBeNull();
  }

  // No other way out: no HTTP client, no second socket, no telemetry. The
  // face is read here too — a shader that phoned home for a texture would be
  // the same hole in a prettier file.
  for (const wayOut of ["fetch(", "XMLHttpRequest", "navigator.sendBeacon", "EventSource("]) {
    expect(allSource, `the widget must not open ${wayOut}`).not.toContain(wayOut);
    expect(face, `the face must not open ${wayOut}`).not.toContain(wayOut);
  }

  // The page is not permitted to load or reach anything either, belt and
  // braces, in the one place a skin author would be tempted to add a font.
  const page = read("index.html");
  expect(page).toContain("default-src 'none'");
  expect(page).toContain("connect-src ws://127.0.0.1:*");

  // And the process cannot be pointed somewhere else: the host is a constant,
  // not configuration. Only the port is read from the environment, and a port
  // does not change which machine the traffic reaches.
  const connection = read("connection.js");
  expect(connection).toContain('const HUB_HOST = "127.0.0.1"');
  expect(connection).not.toContain("process.env.COMCON_WIDGET_HOST");
});

describe("the shell", () => {
  test("draws and does nothing else", () => {
    const main = read("main.js");

    // Frameless, transparent, on top, and out of the taskbar: an orb on the
    // desk rather than an application window.
    expect(main).toContain("frame: false");
    expect(main).toContain("transparent: true");
    expect(main).toContain("alwaysOnTop: true");
    expect(main).toContain("skipTaskbar: true");

    // Clicks fall through the transparent rectangle by default.
    expect(main).toContain("setIgnoreMouseEvents(true");

    // And the default is the only unconditional setting there is. The window is
    // made click-through when it opens, and the single other call is the
    // renderer's report of what it drew — so a hit test that goes wrong leaves
    // the widget transparent, which is the direction the issue insists a bug
    // here must fail in. Swallowing a click meant for the user's editor is the
    // worst outcome available.
    const flips = [...main.matchAll(/setIgnoreMouseEvents\(([^,)]*)/g)].map((match) => match[1]);
    expect(flips).toEqual(["true", "!over"]);

    // It never steals what the user was typing into.
    expect(main).toContain("focusable: false");
    expect(main).toContain("showInactive()");

    // It cannot become a browser: no new windows, no navigation, no webviews.
    expect(main).toContain('action: "deny"');
    expect(main).toContain("will-navigate");
    expect(main).toContain("webviewTag: false");
  });

  test("hands the page what it needs and nothing it shouldn't", () => {
    const preload = read("preload.js");

    // The bridge is the one seam between the sandbox and the process. What is
    // absent from it is the point: no filesystem, no shell, no wholesale
    // ipcRenderer, nothing that reaches the daemon.
    expect(preload).toContain("contextBridge.exposeInMainWorld");
    for (const absent of ["child_process", "node:fs", "exposeInMainWorld('electron'"]) {
      expect(preload).not.toContain(absent);
    }
    // A sandboxed preload is CommonJS, so `require` must exist — but Electron's
    // sandbox shim resolves more than just `electron` (events, timers, url),
    // and any of those widening in here should fail this test. The one module
    // the bridge may pull in is the one it cannot do without.
    const required = [...preload.matchAll(/require\(\s*(["'][^"']*["'])\s*\)/g)].map(
      (match) => match[1],
    );
    expect(required).toEqual(['"electron"']);
    // Handing the page `ipcRenderer` itself would give it every channel at
    // once, including ones added later by someone who never saw this file. So
    // the object may reference it only to send on a named channel, or to
    // listen on one; it may not pass the thing along. Importing it is fine and
    // unavoidable — the check is on how it is used, which is the part that
    // could leak.
    //
    // Listening was added when the window became the whole display: the shell
    // does the snapping and has to hand back somewhere to draw, and a page
    // that cannot be told anything would have to guess. It is still a named
    // channel and still one direction — the page cannot ask a question
    // through it, and a bare `ipcRenderer.on` with no channel named right
    // there fails this test exactly as a passed-along reference does.
    // Comments and imports are stripped first: this is a question about what
    // the code does, and prose that merely mentions the name is not a leak.
    // The CJS require destructure is the import, in the dialect a sandboxed
    // preload actually speaks, so it is stripped for the same reason.
    const body = preload
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*(import|\/\/).*$/gm, "")
      .replace(/^\s*const\s*\{[^}]*\}\s*=\s*require\(.*$/gm, "");
    const uses = [...body.matchAll(/ipcRenderer(.{0,12})/g)].map((match) => match[1] ?? "");
    const passedAlong = uses.filter(
      (after) => !after.startsWith(".send(") && !after.startsWith('.on("widget:'),
    );
    expect(passedAlong, "ipcRenderer may only be used to send on a named channel").toEqual([]);
  });

  test("sits out of the way by default and centres only when asked", () => {
    const area = { width: 1920, height: 1080 };

    // A face that appeared in the middle of the screen every time somebody
    // spoke would land on top of whatever they were reading.
    const corner = placeOrb(area, "corner");
    expect(corner.x).toBeGreaterThan(area.width / 2);
    expect(corner.y).toBeGreaterThan(area.height / 2);

    const centre = placeOrb(area, "center");
    expect(centre.x).toBeLessThan(corner.x);
    expect(centre.y).toBeLessThan(corner.y);

    // Both placements keep the whole orb on the screen.
    for (const placement of [corner, centre]) {
      expect(placement.x).toBeGreaterThanOrEqual(0);
      expect(placement.y).toBeGreaterThanOrEqual(0);
    }
  });

  test("covers one whole display and says where that display is", () => {
    // A second monitor to the left, so the origin is not zero and a stage that
    // quietly assumed it was would be caught here rather than by a scout drawn
    // 1920 pixels from the thing it was pointing at.
    // A panel at the top and a dock on the left, so the work area differs from
    // the display on every axis: a stage that measured the wrong one would put
    // the window somewhere the desktop is not, and every scout on it with it.
    const display = {
      bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
      workArea: { x: 1968, y: 32, width: 2512, height: 1408 },
    };

    const stage = stageFor(display, "corner");

    // The window is the display. Anything smaller is a face that cannot point
    // at the far side of the screen, which is the whole capability here.
    expect({ x: stage.x, y: stage.y, width: stage.width, height: stage.height }).toEqual(
      display.bounds,
    );

    // The orb still sits in the work area's corner, in screen coordinates —
    // clear of a panel at the top and not at the window's own origin.
    expect(stage.orb.x).toBeGreaterThan(display.bounds.x + display.bounds.width / 2);
    expect(stage.orb.y).toBeGreaterThan(display.bounds.y + display.bounds.height / 2);
    expect(stage.orb.y).toBeLessThanOrEqual(
      display.workArea.y + display.workArea.height - HEIGHT,
    );
  });

  test("the stage crosses to the page on one flag, spelled the same way twice", () => {
    // The shell is a module and the preload is CommonJS by construction, so the
    // flag's name is written in both files. A test compares them, because a
    // rename in one place would otherwise ship a page that silently does not
    // know where it is — and a page that does not know where it is draws no
    // scouts at all.
    const flag = "--comcon-stage=";
    expect(read("main.js")).toContain(flag);
    expect(read("preload.js")).toContain(flag);
    expect(read("main.js")).toContain("additionalArguments");

    // The stage is a measurement handed down, not a channel. The page reads it
    // off its own arguments; there is no request it could make for more.
    expect(read("preload.js")).toContain("process.argv");
    expect(read("preload.js")).toContain("stage:");
  });
});

describe("the connection", () => {
  test("keeps knocking after the hub restarts, and backs off doing it", () => {
    // A widget that gave up would still be running, still on top, and
    // permanently deaf — and because it draws nothing when idle, it would
    // look exactly like a widget that is working.
    let delay = 0;
    const delays: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      delay = nextRetryDelay(delay);
      delays.push(delay);
    }

    expect(delays[0]).toBe(250);
    expect(delays[1]).toBeGreaterThan(delays[0]!);
    // Capped, because a widget that has backed off to ten minutes is one the
    // user restarts by hand.
    expect(Math.max(...delays)).toBeLessThanOrEqual(5000);
    expect(delays.at(-1)).toBe(5000);
  });
});

describe("the exit", () => {
  test("quit rides a named IPC channel, not a gesture and not a kill", () => {
    const preload = read("preload.js");
    const main = read("main.js");

    // The bridge offers quit, and it reaches the shell by name. The regex in
    // the bridge test above permits exactly this form — ipcRenderer.send on a
    // named channel — and nothing else, which is why this is the only shape a
    // quit affordance can take.
    expect(preload).toContain('ipcRenderer.send("widget:quit"');
    expect(main).toContain('ipcMain.on("widget:quit"');
    // The shell closes its own windows: never a kill from outside.
    expect(main).toContain("app.quit()");
  });

  test("quit never reaches the hub", () => {
    // Quit is a process-level action, not a conversation gesture. It does not
    // travel the WebSocket, because the hub does not own this process's
    // lifetime — and a face that could ask the hub to kill it would have a
    // power the vocabulary is closed against.
    const connection = read("connection.js");
    expect(connection).not.toContain("quit");
    const stateMachine = read("state-machine.js");
    expect(stateMachine).not.toContain("quit");
  });

  test("right-click opens a menu with a way out", () => {
    const page = read("index.html");
    const renderer = read("renderer.js");

    // The menu is on the page.
    expect(page).toContain('id="menu"');
    expect(page).toContain('id="menu-quit"');
    expect(page).toContain('id="menu-dismiss"');
    expect(page).toContain('id="menu-dashboard"');

    // Right-click is still the interaction; it now opens a menu rather than
    // dismissing immediately.
    expect(renderer).toContain("contextmenu");
  });
});

describe("the dashboard", () => {
  test("opens in a browser, on a channel, at an address the page cannot choose", () => {
    const preload = read("preload.js");
    const main = read("main.js");

    expect(preload).toContain('ipcRenderer.send("widget:open-dashboard"');
    expect(main).toContain('ipcMain.on("widget:open-dashboard"');

    // The bridge carries no URL, and the shell opens exactly one thing: the
    // address it built itself. An always-on-top window that opened links
    // chosen by its page would be a phishing surface with a nice animation,
    // and this is the assertion that keeps a later `openExternal(link)` from
    // slipping in beside this one.
    expect(preload).not.toContain("http");
    const opened = [...main.matchAll(/openExternal\(([^)]*)\)/g)].map((match) => match[1]);
    expect(opened).toEqual(["url"]);
    expect(main).toContain("const url = dashboardUrl(hubPort())");
  });

  test("never reaches the hub", () => {
    // Same ruling as quit: showing the user their own settings page is a
    // shell-level action, so it does not enter the closed gesture vocabulary
    // and nothing about it travels the socket.
    for (const file of ["connection.js", "state-machine.js"]) {
      expect(read(file), `${file} must know nothing about the dashboard`).not.toContain("dashboard");
    }
  });
});

describe("the drag", () => {
  test("the page reports a distance; the shell owns where it lands", () => {
    const preload = read("preload.js");
    const renderer = read("renderer.js");
    const main = read("main.js");

    expect(preload).toContain('ipcRenderer.send("widget:drag"');
    expect(main).toContain('ipcMain.on("widget:drag"');

    // Only the shell decides where the face lands, and only after the request
    // has been read as a drag — a NaN reaching the placement would put the
    // face somewhere nobody can find it.
    expect(main).toContain("readDragRequest(request)");
    expect(main).toContain("dragPlacement(display.workArea, wanted, drag.snap)");

    // The window itself no longer moves. It is the whole display now, and a
    // stage that slid around under the compositor would take the scouts with
    // it — a face pointing at a button would point next to it instead. So the
    // shell answers a drag with a place to draw rather than by moving
    // anything, and neither half calls setPosition at all.
    expect(main).not.toContain("setPosition");
    expect(renderer).not.toContain("setPosition");
    expect(main).toContain('window.webContents.send("widget:placed"');

    // And what comes back is in the page's own coordinates: the stage origin
    // is taken off before it crosses, so the answer to "where do I draw" can
    // never become an answer to "where is my window".
    expect(main).toContain("x: placement.x - stage.x");
    expect(renderer).toContain("window.widget.onPlaced");

    // The page never names a place, only a distance travelled since the press.
    // It cannot name one honestly: on a desk with three monitors it does not
    // know where its own window is.
    expect(renderer).toContain('window.widget.drag("begin"');
    expect(renderer).toContain('window.widget.drag("end"');
  });

  test("the position is written down once, when the hand lets go", () => {
    const main = read("main.js");

    // Persisting on every mousemove would rewrite a file on disk sixty times a
    // second for the length of a drag.
    const writes = [...main.matchAll(/writePlacement\(/g)];
    expect(writes).toHaveLength(1);
    expect(main).toMatch(/drag\.phase === "end"[\s\S]*writePlacement\(/);

    // And it is read back when the window opens, resolved against the display
    // it is opening on rather than replayed as raw pixels. The resolving lives
    // in the stage now, because the stored spot decides two things at once —
    // which display to cover, and where on it the face starts — and they must
    // be answered from the same reading or the face lands on the wrong desk.
    expect(main).toContain("readPlacement(placementFile())");
    expect(main).toContain("screen.getDisplayNearestPoint({ x: stored.x, y: stored.y })");
    expect(main).toContain("stageFor(display, stored ??");
    expect(read("window-shape.js")).toContain("restorePlacement(display.workArea, placement)");
  });
});
