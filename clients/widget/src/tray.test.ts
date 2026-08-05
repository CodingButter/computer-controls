import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { menuTemplateFor, trayIconFile, trayTooltip } from "./tray.js";
import { DEFAULT_TRAY_STATE } from "./tray-state.js";

/**
 * The tray, checked the way this suite checks shells: pure functions by
 * calling them, Electron wiring by reading it.
 *
 * The properties that matter here are about power, not pixels. The tray menu
 * is the only place the widget can be disabled or quit, the dashboard address
 * is built in the main process and never taken from a page, and the renderer
 * is never handed tray control. Those are claims about what the source does
 * and does not say, so the tests read the source — the same discipline the
 * no-ears suite established, on a machine with no display at all.
 */

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const tray = read("./tray.js");
const main = read("./main.js");
const preload = read("./preload.js");
const renderer = read("./renderer.js");

const noop = () => {};
const actions = {
  toggleAutoHide: noop,
  toggleDisabled: noop,
  openDashboard: noop,
  quit: noop,
};

describe("the menu says what it does", () => {
  test("every entry the plan names is there", () => {
    const labels = menuTemplateFor(DEFAULT_TRAY_STATE, actions)
      .map((item) => item.label)
      .filter(Boolean);
    expect(labels).toEqual(["Auto-hide", "Disable widget", "Open the dashboard", "Quit Mastra CC"]);
  });

  test("the auto-hide checkbox is the stored boolean", () => {
    const checkbox = (state: { autoHide: boolean; disabled: boolean }) =>
      menuTemplateFor(state, actions).find((item) => item.label === "Auto-hide");
    expect(checkbox({ autoHide: true, disabled: false })?.checked).toBe(true);
    expect(checkbox({ autoHide: false, disabled: false })?.checked).toBe(false);
  });

  test("the disable entry names the direction it moves", () => {
    const template = menuTemplateFor({ autoHide: true, disabled: true }, actions);
    const labels = template.map((item) => item.label);
    expect(labels).toContain("Enable widget");
    expect(labels).not.toContain("Disable widget");
  });

  test("each entry fires its own action and nothing else's", () => {
    const fired: string[] = [];
    const spying = {
      toggleAutoHide: () => fired.push("autoHide"),
      toggleDisabled: () => fired.push("disabled"),
      openDashboard: () => fired.push("dashboard"),
      quit: () => fired.push("quit"),
    };
    for (const item of menuTemplateFor(DEFAULT_TRAY_STATE, spying)) {
      (item as { click?: () => void }).click?.();
    }
    expect(fired).toEqual(["autoHide", "disabled", "dashboard", "quit"]);
  });
});

describe("the one honest pixel", () => {
  test("disabled shows a different image than working, and both exist", () => {
    const working = trayIconFile(false);
    const disabled = trayIconFile(true);
    expect(working).not.toBe(disabled);
    expect(existsSync(working)).toBe(true);
    expect(existsSync(disabled)).toBe(true);
  });

  test("hovering names the disabled state out loud", () => {
    expect(trayTooltip(false)).toBe("Mastra CC");
    expect(trayTooltip(true)).toContain("disabled");
  });
});

describe("where the power lives", () => {
  test("the tray module holds callbacks, never capabilities", () => {
    // No app, no shell, no URL: the module that draws the menu cannot quit
    // the process, open a page, or reach a renderer on its own. Everything
    // it fires was handed to it by main.
    expect(tray).not.toContain("app.");
    expect(tray).not.toContain("openExternal");
    expect(tray).not.toContain("http");
    expect(tray).not.toContain("ipcMain");
    expect(tray).not.toContain("ipcRenderer");
  });

  test("quit lives in main, behind the menu and the face's own gesture", () => {
    expect(main).toContain("quit: () => app.quit()");
    expect(main).toContain('ipcMain.on("widget:quit", () => app.quit())');
    // And nowhere else: two doors, both of them semantic closes.
    expect(main.match(/app\.quit\(\)/g)).toHaveLength(2);
  });

  test("a closed window no longer closes the application", () => {
    // The listener must exist — its existing is what stops Electron's
    // default exit — and must do nothing, because the tray owns the lifetime.
    const handler = main.match(/app\.on\("window-all-closed",\s*\(\)\s*=>\s*\{\}\)/);
    expect(handler).not.toBeNull();
  });

  test("the dashboard address is still built in main, once", () => {
    // The tray's entry and the face's context-menu entry share the one
    // openExternal main.js has always had. A second call site would be a
    // second thing to audit.
    const calls = [...main.matchAll(/openExternal\(([^)]*)\)/g)].map((match) => match[1]);
    expect(calls).toEqual(["url"]);
    expect(tray).not.toContain("dashboardUrl");
  });
});

describe("the renderer is told, never asked", () => {
  test("tray state crosses the bridge in one direction", () => {
    // The page hears the choices so it can run the fade timer; it has no
    // member to change them. A page that could disable its own indicator
    // would defeat the indicator.
    expect(preload).toContain('ipcRenderer.on("widget:tray-state"');
    expect(preload).not.toContain('ipcRenderer.send("widget:tray-state"');
    expect(renderer).not.toContain("tray-state");
    expect(main).toContain('window.webContents.send("widget:tray-state"');
  });

  test("the choices are written down on every change", () => {
    // Persisted inside the state-change path itself — a choice that only
    // survived a clean exit would be lost to every crash.
    expect(main).toContain("readTrayState(trayStateFile())");
    expect(main).toMatch(/trayState = next;\s*\n\s*writeTrayState\(trayStateFile\(\), trayState\)/);
  });

  test("a widget disabled last run starts hidden, not visible-for-a-frame", () => {
    expect(main).toContain("createWindow({ startHidden: trayState.disabled })");
    expect(main).toMatch(/if \(!startHidden\) window\.showInactive\(\)/);
  });

  test("the fade timer runs where the events land", () => {
    // Every lane event rewinds the clock, so "listening or talking means
    // visible" is structural rather than a race against the timeout.
    expect(renderer).toContain("AUTO_HIDE_MS");
    expect(renderer).toMatch(/state = reduce\(state, event\);\s*\n\s*paint\(\);\s*\n\s*rewindFade\(\)/);
    expect(renderer).toContain("state = fade(state, autoHide)");
  });
});
