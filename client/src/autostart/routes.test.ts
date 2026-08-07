/**
 * The start-on-boot door, proven against a real temporary home directory
 * rather than a mock — the atomicity and the read-from-disk honesty are the
 * feature, and neither can be shown against a fake filesystem.
 */

import { readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { freedesktopPlatform } from "../platform/freedesktop/index.ts";
import { desktopEntryFor, freedesktopAutostart } from "../platform/freedesktop/autostart.ts";
import { macosPlatform } from "../platform/unimplemented.ts";
import {
  AUTOSTART_PATH,
  WIDGET_AUTOSTART_ID,
  buildAutostartApp,
  widgetExec,
  type AutostartView,
} from "./routes.ts";

const EXEC = '"/usr/bin/true" "--widget"';

let home: string;
let app: ReturnType<typeof buildAutostartApp>;

const entryFile = () =>
  path.join(home, ".config", "autostart", `${WIDGET_AUTOSTART_ID}.desktop`);

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "autostart-routes-"));
  app = buildAutostartApp({ platform: freedesktopPlatform({ HOME: home }), exec: EXEC });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const read = async (): Promise<AutostartView> => {
  const response = await app.request(AUTOSTART_PATH);
  expect(response.status).toBe(200);
  return (await response.json()) as AutostartView;
};

const save = (body: unknown) =>
  app.request(AUTOSTART_PATH, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("the toggle reflects the disk, not a memory", () => {
  it("answers disabled with the path it would write, before anything exists", async () => {
    const view = await read();
    expect(view).toEqual({ supported: true, enabled: false, path: entryFile() });
  });

  it("a deleted entry reads as disabled without a write in between", async () => {
    await save({ enabled: true });
    await rm(entryFile());
    const view = await read();
    expect(view).toEqual({ supported: true, enabled: false, path: entryFile() });
  });
});

describe("writing the entry", () => {
  it("enabling writes a desktop entry the session manager can read", async () => {
    const response = await save({ enabled: true });
    expect(response.status).toBe(200);
    expect((await response.json()).enabled).toBe(true);

    const written = await readFile(entryFile(), "utf8");
    expect(written).toContain("[Desktop Entry]");
    expect(written).toContain("Name=Mastra CC");
    expect(written).toContain(`Exec=${EXEC}`);
  });

  it("leaves no temp litter behind — the write is rename, not truncate", async () => {
    await save({ enabled: true });
    const names = await readdir(path.dirname(entryFile()));
    expect(names).toEqual([path.basename(entryFile())]);
  });

  it("disabling removes the entry, and removing what is absent is a success", async () => {
    await save({ enabled: true });
    const off = await save({ enabled: false });
    expect(off.status).toBe(200);
    expect((await off.json()).enabled).toBe(false);
    expect(await read()).toEqual({ supported: true, enabled: false, path: entryFile() });
    await expect(readFile(entryFile(), "utf8")).rejects.toThrow();

    const again = await save({ enabled: false });
    expect(again.status).toBe(200);
  });
});

describe("refusals", () => {
  it.each([
    ["no body key", {}],
    ["a string where a boolean goes", { enabled: "yes" }],
    ["a number", { enabled: 1 }],
    ["null", { enabled: null }],
  ])("refuses %s without writing anything", async (_name, body) => {
    const response = await save(body);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("enabled must be true or false");
    expect(await read()).toEqual({ supported: true, enabled: false, path: entryFile() });
  });

  it("refuses a body that is not JSON at all", async () => {
    const response = await app.request(AUTOSTART_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });
});

describe("an OS with no autostart answers honestly", () => {
  it("GET is the reason arm, not a dead toggle", async () => {
    const other = buildAutostartApp({ platform: macosPlatform({ HOME: home }), exec: EXEC });
    const response = await other.request(AUTOSTART_PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      supported: false,
      reason: "Start on boot is not supported on macos yet.",
    });
  });

  it("PUT refuses with the same sentence and touches nothing", async () => {
    const other = buildAutostartApp({ platform: macosPlatform({ HOME: home }), exec: EXEC });
    const response = await other.request(AUTOSTART_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("Start on boot is not supported on macos yet.");
  });
});

describe("the entry format defends its own fields", () => {
  it("refuses a field that could author another line", () => {
    expect(() =>
      desktopEntryFor({ id: "x", name: "Nice\nExec=rm -rf /", exec: "/usr/bin/true" }),
    ).toThrow(/control characters/);
    expect(() => desktopEntryFor({ id: "x", name: "", exec: "/usr/bin/true" })).toThrow();
  });

  it("XDG_CONFIG_HOME wins over HOME when both are set", () => {
    const port = freedesktopAutostart({ HOME: "/home/nobody", XDG_CONFIG_HOME: "/elsewhere" });
    expect(port.path("thing")).toBe("/elsewhere/autostart/thing.desktop");
  });

  it("an empty XDG_CONFIG_HOME is unset, not an answer", () => {
    // Taken as an answer it would write the entry to a relative `autostart/`
    // beside wherever the hub was started, where no session manager looks.
    const port = freedesktopAutostart({ HOME: "/home/nobody", XDG_CONFIG_HOME: "" });
    expect(port.path("thing")).toBe("/home/nobody/.config/autostart/thing.desktop");
  });
});

describe("the default command", () => {
  it("points at this checkout's widget under its own electron", () => {
    const exec = widgetExec();
    expect(exec).toContain(path.join("clients", "widget"));
    expect(exec).toContain(path.join("node_modules", ".bin", "electron"));
  });
});
