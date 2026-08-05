import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// The shell's manners, importable without starting Electron. `main.js` itself
// is read as text below rather than imported, because importing it would mean
// this suite could only run on a machine with a display.
import { GRANTED_PERMISSIONS, placeWindow } from "./window-shape.js";
import { hubEventsUrl, nextRetryDelay } from "./connection.js";

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

  // Exactly one address is built in this process, and it is loopback.
  expect(hubEventsUrl(4111)).toBe("ws://127.0.0.1:4111/events");
  expect(hubEventsUrl(9999)).toContain("127.0.0.1");

  // No other way out: no HTTP client, no second socket, no telemetry.
  for (const wayOut of ["fetch(", "XMLHttpRequest", "navigator.sendBeacon", "EventSource("]) {
    expect(allSource, `the widget must not open ${wayOut}`).not.toContain(wayOut);
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
    // the object may reference it only to send on a named channel; it may not
    // pass the thing along. Importing it is fine and unavoidable — the check
    // is on how it is used, which is the part that could leak.
    // Comments and imports are stripped first: this is a question about what
    // the code does, and prose that merely mentions the name is not a leak.
    // The CJS require destructure is the import, in the dialect a sandboxed
    // preload actually speaks, so it is stripped for the same reason.
    const body = preload
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*(import|\/\/).*$/gm, "")
      .replace(/^\s*const\s*\{[^}]*\}\s*=\s*require\(.*$/gm, "");
    const uses = [...body.matchAll(/ipcRenderer(.{0,7})/g)].map((match) => match[1] ?? "");
    const passedAlong = uses.filter((after) => !after.startsWith(".send("));
    expect(passedAlong, "ipcRenderer may only be used to send on a named channel").toEqual([]);
  });

  test("sits out of the way by default and centres only when asked", () => {
    const area = { width: 1920, height: 1080 };

    // A face that appeared in the middle of the screen every time somebody
    // spoke would land on top of whatever they were reading.
    const corner = placeWindow(area, "corner");
    expect(corner.x).toBeGreaterThan(area.width / 2);
    expect(corner.y).toBeGreaterThan(area.height / 2);

    const centre = placeWindow(area, "center");
    expect(centre.x).toBeLessThan(corner.x);
    expect(centre.y).toBeLessThan(corner.y);

    // Both placements keep the whole window on the screen.
    for (const placement of [corner, centre]) {
      expect(placement.x).toBeGreaterThanOrEqual(0);
      expect(placement.y).toBeGreaterThanOrEqual(0);
    }
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

    // Right-click is still the interaction; it now opens a menu rather than
    // dismissing immediately.
    expect(renderer).toContain("contextmenu");
  });
});
