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
 * The widget's boundaries — a mouth and ears, still no daemon path, still no
 * key, still no screen capture — checked against the code that ships.
 *
 * This suite replaces no-ears.test.ts, and the replacement is the one
 * sanctioned rewrite of this plan: the widget grew a microphone on purpose,
 * so "no ear anywhere" stopped being the truth. What did not change is the
 * method or the strength. This is still a source-level test — the claim is
 * not "the widget did not misbehave during this run" but "the capability
 * exists nowhere in the text of the program" — and every category the old
 * suite scanned is scanned here, narrowed only where this segment
 * deliberately opened a door. Each opened door is named, per-file: an audio
 * API in a file not on the allowlist fails exactly as it always did.
 *
 * It also holds up where a runtime test could not run at all. The widget is
 * an Electron window and this suite runs on machines with no display.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** Every module that ships at the top level of the widget process. */
const shipped = readdirSync(SRC)
  .filter((name) => /\.(js|html)$/.test(name))
  .sort();

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

/**
 * Prose is not a leak. The scans below are questions about what the code
 * does, and a comment that mentions `getUserMedia` while explaining why a
 * file must not call it would otherwise fail the very test it documents.
 * Block comments and line-leading `//` comments are stripped; nothing that
 * executes lives in either.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const code = (name: string) => (name.endsWith(".html") ? read(name) : stripComments(read(name)));

/**
 * The vendored trees ship too, and the flat scan above does not reach them.
 *
 * `shipped` is a flat read of src/, so src/face/ and src/vendor/ fall
 * outside it. For face/ that placement is deliberate and load-bearing:
 * three.module.js carries audio-path source the widget never invokes, and a
 * flat scan would read those dead strings as an ear. For vendor/ it is the
 * same shape with a live twist: vendor/live/ is the hub's own browser-safe
 * module, and session.js in there legitimately dials Google — that is the
 * mouth. Both trees are held honest the same way: face-parity.test.ts pins
 * every vendored file byte-for-byte to the hub's copy, so nothing here can
 * acquire a capability the hub's reviewed original did not have.
 *
 * The exemption stops at the vendored libraries. `orb-webgl.js` is this
 * project's own code, it runs in the same renderer as everything else, and
 * it gets read by the same rules.
 */
const face = read("face/orb-webgl.js");

describe("the ears", () => {
  test("audio capture exists in exactly the named files, and nowhere else", () => {
    // The suite is reading real files, not an empty directory that would make
    // every assertion below vacuously true — and the allowlist below is
    // scanning files that exist, not a list that quietly rotted.
    expect(shipped).toContain("main.js");
    expect(shipped).toContain("renderer.js");
    expect(shipped).toContain("preload.js");
    expect(shipped).toContain("ears.js");
    expect(shipped).toContain("mouth.js");
    expect(shipped).toContain("ear-worker.js");
    expect(shipped.length).toBeGreaterThan(8);

    // The doors this segment opened, each in one named file. The ears own
    // the microphone and the capture graph; the mouth owns a playback
    // context. No other file may name any of these.
    const allowed: Record<string, string[]> = {
      "ears.js": [
        "getUserMedia",
        "mediaDevices",
        "AudioContext",
        "AudioWorklet",
        "createMediaStreamSource",
      ],
      "mouth.js": ["AudioContext"],
    };

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
    for (const name of shipped) {
      const body = code(name);
      for (const call of waysToOpenAnEar) {
        if (allowed[name]?.includes(call)) continue;
        expect(body, `${name} must not reach for ${call}`).not.toContain(call);
      }
    }
    for (const call of waysToOpenAnEar) {
      expect(face, `the face must not reach for ${call}`).not.toContain(call);
    }

    // And some doors stay shut for every file, allowlist or not: recording
    // to a blob, capturing a screen, or feature-probing permissions is not
    // part of a mouth or an ear.
    const neverAnywhere = [
      "MediaRecorder",
      "getDisplayMedia",
      "desktopCapturer",
      "webkitAudioContext",
      "navigator.permissions",
    ];
    for (const name of Object.keys(allowed)) {
      for (const call of neverAnywhere) {
        expect(code(name), `${name} must not reach for ${call}`).not.toContain(call);
      }
    }
  });

  test("three.js's own audio path stays dead", () => {
    // three.js can open an ear of its own — an AudioListener is a WebAudio
    // context wearing a scene-graph hat. Nothing the widget draws with may
    // name one, which is what keeps the vendored library's audio path dead
    // rather than merely unused today.
    const allSource = shipped.map(code).join("\n");
    for (const audio of ["AudioListener", "PositionalAudio", "AudioAnalyser", "AudioLoader"]) {
      expect(allSource, `the widget must not construct three's ${audio}`).not.toContain(audio);
      expect(face, `the face must not construct three's ${audio}`).not.toContain(audio);
    }
  });

  test("the microphone is echo-cancelled and the plug drops frames before the gate", () => {
    const ears = read("ears.js");
    // Chromium's echo cancellation is what keeps the mouth's own playback
    // from becoming the next utterance.
    expect(ears).toContain("echoCancellation: true");
    // Plugged ears drop the frame upstream of the gate: not buffered, not
    // considered. A plugged widget is not remembering audio to act on later.
    expect(ears).toMatch(/if \(plugged\) return;[\s\S]{0,200}gate\.push\(/);
    // The gate is the hub's own, vendored — not a local reimplementation
    // whose privacy property nobody re-proved.
    expect(ears).toContain('from "./vendor/live/gate.js"');
  });

  test("the ear's model runs from disk, never the network", () => {
    const worker = read("ear-worker.js");
    // A missing model is a widget with no ear — never a widget that quietly
    // phones Hugging Face at first run.
    expect(worker).toContain("env.allowRemoteModels = false");
    expect(worker).toContain("env.allowLocalModels = true");
    expect(worker).toContain('env.localModelPath = new URL("./vendor/ear/model/"');
    expect(worker).toContain('new URL("./vendor/ear/lib/"');
    // One thread: more would need SharedArrayBuffer, which needs COOP/COEP,
    // which the spike proved unnecessary.
    expect(worker).toContain("numThreads = 1");
  });
});

describe("the permissions", () => {
  test("one carve-out — the microphone, audio only, for the widget's own page", () => {
    // The declared list and the enforced handlers must agree. `media` is the
    // whole list: the ears are the one thing a face that draws and listens
    // needs, and everything else stays denied.
    expect(GRANTED_PERMISSIONS).toEqual(["media"]);

    const main = read("main.js");
    // Asked politely, and checked ahead of asking: the same predicate
    // answers both, so a feature-detect can never find a door the request
    // handler would have closed — or miss the one it would have opened.
    expect(main).toContain("setPermissionRequestHandler");
    expect(main).toContain("setPermissionCheckHandler");
    // The predicate's clauses, each one load-bearing: not while disabled,
    // media and nothing else, the widget's own page and nowhere else, audio
    // and never video.
    expect(main).toContain("if (isDisabled()) return false;");
    expect(main).toContain('if (permission !== "media") return false;');
    expect(main).toContain("if (requestingUrl !== widgetPageUrl()) return false;");
    // The whole predicate line, including the non-empty guard: `every` on an
    // empty array is vacuously true, and a request naming no media types
    // must read as refusal, not as a grant with nothing attached.
    expect(main).toContain('mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio")');
    // Named devices are still refused: getUserMedia reaches the default
    // microphone; enumerating and claiming hardware is not a thing a face does.
    expect(main).toContain("setDevicePermissionHandler(() => false)");
  });

  test("screen capture is refused permanently, in every state", () => {
    // The ears carve-out changes nothing here and never will. A widget that
    // could see the screen would be a keylogger with a nice animation.
    const main = read("main.js");
    expect(main).toContain("setDisplayMediaRequestHandler");
    expect(main).toContain("callback({ video: undefined, audio: undefined })");
  });

  test("the renderer stays a document", () => {
    // Node inside the page would be a way around every line above, since a
    // page with `require` does not need a permission to read a device.
    const main = read("main.js");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("sandbox: true");
  });
});

describe("the network", () => {
  test("every address this process builds is loopback or the one named voice endpoint", () => {
    // The two loopback addresses: the socket the face listens on, and the
    // dashboard the shell hands to a browser. Only the port varies in
    // either, and a port does not change which machine the traffic reaches.
    expect(hubEventsUrl(4111)).toBe("ws://127.0.0.1:4111/events");
    expect(hubEventsUrl(9999)).toContain("127.0.0.1");
    expect(dashboardUrl(4111)).toBe("http://127.0.0.1:4111/");
    expect(dashboardUrl(9999)).toContain("http://127.0.0.1:");
    // A port that is not a port opens nothing at all, rather than an address
    // assembled out of whatever was in the environment.
    for (const notAPort of [Number.NaN, 0, -1, 70000, 4111.5]) {
      expect(dashboardUrl(notAPort), String(notAPort)).toBeNull();
    }

    // The process cannot be pointed somewhere else: the host is a constant,
    // not configuration.
    const connection = read("connection.js");
    expect(connection).toContain('const HUB_HOST = "127.0.0.1"');
    expect(connection).not.toContain("process.env.COMCON_WIDGET_HOST");
  });

  test("main holds exactly one HTTP client, aimed at the hub's token mint", () => {
    // The one fetch this segment opened: the mint rides main so the renderer
    // never learns the hub's port twice. It is one call, to a loopback
    // address built from a constant host — and every other file still holds
    // no HTTP client, no telemetry, no second socket.
    const main = code("main.js");
    const fetches = [...main.matchAll(/fetch\(/g)];
    expect(fetches).toHaveLength(1);
    expect(main).toContain("`http://127.0.0.1:${hubPort()}/api/orb/token`");

    for (const name of shipped.filter((file) => file !== "main.js")) {
      const body = code(name);
      for (const wayOut of ["fetch(", "XMLHttpRequest", "navigator.sendBeacon", "EventSource("]) {
        expect(body, `${name} must not open ${wayOut}`).not.toContain(wayOut);
      }
    }
    for (const wayOut of ["fetch(", "XMLHttpRequest", "navigator.sendBeacon", "EventSource("]) {
      expect(face, `the face must not open ${wayOut}`).not.toContain(wayOut);
    }

    // The egress primitive this segment legitimized gets the same treatment:
    // one socket, in one file. connection.js holds the lane; the vendored
    // session holds the Google dial and is pinned byte-for-byte by the parity
    // test. Nothing else in the shipped page may so much as spell the word —
    // a renderer that opened its own WebSocket would be a second lane nobody
    // audits.
    for (const name of shipped.filter((file) => file !== "connection.js")) {
      expect(code(name), `${name} must not reach for WebSocket`).not.toContain("WebSocket");
    }
    expect(face, "the face must not reach for WebSocket").not.toContain("new WebSocket");
  });

  test("the page's CSP names the two doors and closes everything else", () => {
    // Pinned whole: each widening was deliberate, and a CSP that grew a
    // third connect host or a remote script source should fail loudly, not
    // slide by a substring check. The loopback port wildcard is deliberate
    // too — the hub's port rides COMCON_CLIENT_PORT, so the CSP cannot name
    // one number; script-src 'self' is what bounds who could dial it.
    const page = read("index.html");
    const policy = page.match(/http-equiv="Content-Security-Policy"\s*\n\s*content="([^"]*)"/);
    expect(policy, "the page must carry a CSP").not.toBeNull();
    expect(policy![1]).toBe(
      "default-src 'none'; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
        "worker-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://generativelanguage.googleapis.com",
    );

    // The voice host in the CSP is the host the vendored session actually
    // dials — the page-side half and the code-side half of "audio goes
    // exactly one place" must be the same place.
    const session = read("vendor/live/session.js");
    expect(session).toContain("wss://generativelanguage.googleapis.com");
  });

  test("the mouth dials through the vendored session and names no endpoint of its own", () => {
    const mouth = code("mouth.js");
    expect(mouth).toContain('from "./vendor/live/session.js"');
    expect(mouth).not.toContain("wss://");
    expect(mouth).not.toContain("ws://");
  });

  test("no token or credential ever lands on disk, and no key exists to land", () => {
    const allSource = shipped.map(code).join("\n") + face;
    // A minted token lives in memory for the length of a dial. Web storage
    // in any shipped file would be a place for one to outlive its session.
    for (const store of ["localStorage", "sessionStorage", "indexedDB"]) {
      expect(allSource, `nothing may persist through ${store}`).not.toContain(store);
    }
    // And no credential-shaped anything: the key stays on the hub, which is
    // the entire design of the mint.
    expect(allSource).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
    expect(allSource).not.toContain("x-goog-api-key");
  });
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

    // And the default is the only unconditional setting there is. The window
    // is made click-through when it opens, and the single other call is the
    // renderer's report of what it drew — so a hit test that goes wrong
    // leaves the widget transparent, which is the direction a bug here must
    // fail in. Swallowing a click meant for the user's editor is the worst
    // outcome available.
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

    // The bridge is the one seam between the sandbox and the process. What
    // is absent from it is the point: no filesystem, no shell, no wholesale
    // ipcRenderer, nothing that reaches the daemon.
    expect(preload).toContain("contextBridge.exposeInMainWorld");
    for (const absent of ["child_process", "node:fs", "exposeInMainWorld('electron'"]) {
      expect(preload).not.toContain(absent);
    }
    // No URL crosses the bridge in either direction — checked on the code,
    // not the prose that explains why.
    expect(stripComments(preload)).not.toContain("http");
    // A sandboxed preload is CommonJS, so `require` must exist — but
    // Electron's sandbox shim resolves more than just `electron` (events,
    // timers, url), and any of those widening in here should fail this test.
    const required = [...preload.matchAll(/require\(\s*(["'][^"']*["'])\s*\)/g)].map(
      (match) => match[1],
    );
    expect(required).toEqual(['"electron"']);
    // Handing the page `ipcRenderer` itself would give it every channel at
    // once, including ones added later by someone who never saw this file.
    // So the object may reference it only to send on a named channel, to
    // listen on one, or to ask on one — it may not pass the thing along.
    // Asking was added with the mouth: the token mint rides main, and an
    // invoke on a named channel is the one request/response the page makes.
    // Comments and imports are stripped first: this is a question about what
    // the code does, and prose that merely mentions the name is not a leak.
    const body = preload
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*(import|\/\/).*$/gm, "")
      .replace(/^\s*const\s*\{[^}]*\}\s*=\s*require\(.*$/gm, "");
    const uses = [...body.matchAll(/ipcRenderer(.{0,12})/g)].map((match) => match[1] ?? "");
    const passedAlong = uses.filter(
      (after) =>
        !after.startsWith(".send(") &&
        !after.startsWith('.on("widget:') &&
        !after.startsWith('.invoke("wid'),
    );
    expect(passedAlong, "ipcRenderer may only be used on a named channel").toEqual([]);
    // And the ask is exactly one channel: the mint. A second invoke is a
    // second question this bridge was never designed to carry.
    const invokes = [...body.matchAll(/ipcRenderer\.invoke\(\s*("[^"]*")/g)].map(
      (match) => match[1],
    );
    expect(invokes).toEqual(['"widget:mint-token"']);
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
    // A second monitor to the left, so the origin is not zero and a stage
    // that quietly assumed it was would be caught here rather than by a
    // scout drawn 1920 pixels from the thing it was pointing at. A panel at
    // the top and a dock on the left, so the work area differs from the
    // display on every axis.
    const display = {
      bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
      workArea: { x: 1968, y: 32, width: 2512, height: 1408 },
    };

    const stage = stageFor(display, "corner");

    // The window is the display. Anything smaller is a face that cannot
    // point at the far side of the screen, which is the whole capability here.
    expect({ x: stage.x, y: stage.y, width: stage.width, height: stage.height }).toEqual(
      display.bounds,
    );

    // The orb still sits in the work area's corner, in screen coordinates —
    // clear of a panel at the top and not at the window's own origin.
    expect(stage.orb.x).toBeGreaterThan(display.bounds.x + display.bounds.width / 2);
    expect(stage.orb.y).toBeGreaterThan(display.bounds.y + display.bounds.height / 2);
    expect(stage.orb.y).toBeLessThanOrEqual(display.workArea.y + display.workArea.height - HEIGHT);
  });

  test("the stage crosses to the page on one flag, spelled the same way twice", () => {
    // The shell is a module and the preload is CommonJS by construction, so
    // the flag's name is written in both files. A test compares them,
    // because a rename in one place would otherwise ship a page that
    // silently does not know where it is — and a page that does not know
    // where it is draws no scouts at all.
    const flag = "--comcon-stage=";
    expect(read("main.js")).toContain(flag);
    expect(read("preload.js")).toContain(flag);
    expect(read("main.js")).toContain("additionalArguments");

    // The stage is a measurement handed down, not a channel. The page reads
    // it off its own arguments; there is no request it could make for more.
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
    // the bridge test above permits exactly this form — ipcRenderer.send on
    // a named channel — and nothing else, which is why this is the only
    // shape a quit affordance can take.
    expect(preload).toContain('ipcRenderer.send("widget:quit"');
    expect(main).toContain('ipcMain.on("widget:quit"');
    // The shell closes its own windows: never a kill from outside.
    expect(main).toContain("app.quit()");
  });

  test("quit never reaches the hub", () => {
    // Quit is a process-level action, not a conversation gesture. It does
    // not travel the WebSocket, because the hub does not own this process's
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

    // Right-click is still the interaction; it opens a menu rather than
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
    const opened = [...main.matchAll(/openExternal\(([^)]*)\)/g)].map((match) => match[1]);
    expect(opened).toEqual(["url"]);
    expect(main).toContain("const url = dashboardUrl(hubPort())");
  });

  test("never reaches the hub", () => {
    // Same ruling as quit: showing the user their own settings page is a
    // shell-level action, so it does not enter the closed gesture vocabulary
    // and nothing about it travels the socket.
    for (const file of ["connection.js", "state-machine.js"]) {
      expect(read(file), `${file} must know nothing about the dashboard`).not.toContain(
        "dashboard",
      );
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

    // Only the shell decides where the face lands, and only after the
    // request has been read as a drag — a NaN reaching the placement would
    // put the face somewhere nobody can find it.
    expect(main).toContain("readDragRequest(request)");
    expect(main).toContain("dragPlacement(display.workArea, wanted, drag.snap)");

    // The window itself never moves. It is the whole display, and a stage
    // that slid around under the compositor would take the scouts with it —
    // so the shell answers a drag with a place to draw rather than by moving
    // anything, and neither half calls setPosition at all.
    expect(main).not.toContain("setPosition");
    expect(renderer).not.toContain("setPosition");
    expect(main).toContain('window.webContents.send("widget:placed"');

    // And what comes back is in the page's own coordinates: the stage origin
    // is taken off before it crosses, so the answer to "where do I draw" can
    // never become an answer to "where is my window".
    expect(main).toContain("x: placement.x - stage.x");
    expect(renderer).toContain("window.widget.onPlaced");

    // The page never names a place, only a distance travelled since the
    // press. It cannot name one honestly: on a desk with three monitors it
    // does not know where its own window is.
    expect(renderer).toContain('window.widget.drag("begin"');
    expect(renderer).toContain('window.widget.drag("end"');
  });

  test("the position is written down once, when the hand lets go", () => {
    const main = read("main.js");

    // Persisting on every mousemove would rewrite a file on disk sixty times
    // a second for the length of a drag.
    const writes = [...main.matchAll(/writePlacement\(/g)];
    expect(writes).toHaveLength(1);
    expect(main).toMatch(/drag\.phase === "end"[\s\S]*writePlacement\(/);

    // And it is read back when the window opens, resolved against the
    // display it is opening on rather than replayed as raw pixels.
    expect(main).toContain("readPlacement(placementFile())");
    expect(main).toContain("screen.getDisplayNearestPoint({ x: stored.x, y: stored.y })");
    expect(main).toContain("stageFor(display, stored ??");
    expect(read("window-shape.js")).toContain("restorePlacement(display.workArea, placement)");
  });
});
