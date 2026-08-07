import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * The enrollment surface, checked the way this suite checks wiring: by reading
 * the source. The power properties — the page owns the recording but not the
 * filesystem, the overlay claims the pointer while it is open, the shell opens
 * it and nothing else does — are claims about what the code says, so the tests
 * read what the code says.
 *
 * No display, no microphone: the question is whether the wires are drawn
 * between the right rooms, not whether the rooms are lit.
 */

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const tray = read("./tray.js");
const main = read("./main.js");
const preload = read("./preload.js");
const renderer = read("./renderer.js");
const ears = read("./ears.js");
const enrollment = read("./enrollment.js");
const index = read("./index.html");

describe("entry points: the shell opens enrollment, nothing else does", () => {
  test("the tray menu carries a tune-wake-word callback", () => {
    expect(tray).toContain("Tune the wake word to my voice");
    expect(tray).toContain("tuneWakeWord");
  });

  test("the tray action asks the page to start enrollment", () => {
    // The tray module holds only callbacks; main translates the callback into
    // a one-way message to the page, the same way it translates openDashboard
    // into an external-browser open.
    expect(main).toContain('window.webContents.send("widget:start-enrollment"');
  });

  test("first launch offers enrollment when no templates are enrolled", () => {
    // The check reads the wake-templates file: an absent or empty file means
    // enrolled is false, which is the first-launch signal. It must not fire
    // while the widget is disabled — a disabled widget has no microphone.
    expect(main).toContain("readWakeTemplates");
    expect(main).toContain("!readWakeTemplates");
    expect(main).toContain(".enrolled");
    expect(main).toMatch(/!trayState\.disabled/);
  });

  test("the write handler persists templates in the main process", () => {
    // The page cannot write files; it hands the templates to the shell, which
    // owns the filesystem. The send is fire-and-forget, so the page keeps its
    // session templates in memory and the shell writes them down.
    expect(main).toContain('ipcMain.on("widget:write-wake-templates"');
    expect(main).toContain("writeWakeTemplates");
  });
});

describe("the bridge: the page hears the shell, not the filesystem", () => {
  test("start-enrollment is receive-only, like tray-state", () => {
    // The page is told when to open enrollment; it has no member to demand it.
    expect(preload).toContain('ipcRenderer.on("widget:start-enrollment"');
    expect(preload).toContain("onStartEnrollment");
  });

  test("write-wake-templates is a send, not an ask", () => {
    // Persistence crosses the bridge as a fire-and-forget send, keeping the
    // one invoke the bridge carries (the mint) exactly one.
    expect(preload).toContain('ipcRenderer.send("widget:write-wake-templates"');
    expect(preload).toContain("writeWakeTemplates");
  });
});

describe("the overlay claims the pointer while it is open", () => {
  test("enrollment names no audio, network, or storage API of its own", () => {
    // The capture lives in ears.js, the scoring in wake-score.js, the
    // persistence on the bridge. This module is the glue, and a flat scan of
    // the shipped source for "ways to open an ear" finds none here.
    const banned = [
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
      "fetch(",
      "WebSocket",
      "XMLHttpRequest",
      "sendBeacon",
      "localStorage",
      "indexedDB",
      "node:fs",
    ];
    for (const token of banned) {
      expect(enrollment, `enrollment.js must not name ${token}`).not.toContain(token);
    }
  });

  test("enrollment imports only the capture and the scorer", () => {
    // ears.js owns the microphone (enrollTake), wake-score.js owns the math
    // (assembleTemplates). wake-templates.js is main-process-only (it touches
    // the filesystem) and must not be imported here.
    expect(enrollment).toContain('from "./ears.js"');
    expect(enrollment).toContain('from "./wake-score.js"');
    expect(enrollment).not.toContain('from "./wake-templates.js"');
  });

  test("the overlay claims the pointer on open and releases it on close", () => {
    // The window is click-through except over shapes it drew, so the overlay
    // must say "I am here" or its buttons fall through the floor — the same
    // reason the right-click menu claims the pointer.
    expect(enrollment).toContain("setPointerOverShape(true)");
    expect(enrollment).toContain("setPointerOverShape(false)");
  });

  test("save writes templates with enrolled true and closes", () => {
    expect(enrollment).toContain("writeWakeTemplates");
    expect(enrollment).toMatch(/\{ templates, enrolled: true \}/);
  });
});

describe("the renderer yields the pointer to the overlay", () => {
  test("the renderer mounts enrollment and opens it from the shell message", () => {
    expect(renderer).toContain('from "./enrollment.js"');
    expect(renderer).toContain("createEnrollment");
    expect(renderer).toContain("onStartEnrollment");
  });

  test("the mousemove and contextmenu handlers defer to the overlay", () => {
    // An unguarded mousemove would release the pointer claim and drop the
    // overlay's clicks through the floor; the contextmenu would open the
    // right-click menu underneath it. Both check isOpen().
    expect(renderer).toMatch(/enrollment\.isOpen\(\)/);
  });
});

describe("the page carries the overlay markup", () => {
  test("the enrollment overlay exists alongside the menu", () => {
    expect(index).toContain('id="enrollment"');
    expect(index).toContain("data-enroll-phrase");
    expect(index).toContain("data-enroll-takes");
    expect(index).toContain("data-enroll-save");
    expect(index).toContain("data-enroll-skip");
  });

  test("the right-click menu is untouched: still exactly three buttons", () => {
    const menuButtons = index.match(/id="menu-/g) ?? [];
    expect(menuButtons).toHaveLength(3);
  });
});

describe("the capture reuses the allowlisted audio graph", () => {
  test("enrollTake lives in ears.js and opens the same graph as startEars", () => {
    // The boundaries suite allows ears.js to name getUserMedia,
    // AudioContext, AudioWorklet, and createMediaStreamSource. The enrollment
    // capture reuses that graph rather than introducing a new file or a new
    // API, which is why no other module names them.
    expect(ears).toContain("enrollTake");
    expect(ears).toContain("getUserMedia");
    expect(ears).toContain("AudioContext");
    expect(ears).toContain("createMediaStreamSource");
  });
});
