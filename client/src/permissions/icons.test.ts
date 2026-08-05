import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DesktopEntryApp } from "./desktop-entries.ts";
import { createIconSource, resolveIcon, type IconLookupDirs } from "./icons.ts";

let tmp: string;
let dirs: IconLookupDirs;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "icons-test-"));
  dirs = {
    iconRoots: [path.join(tmp, "icons")],
    pixmapsDirs: [path.join(tmp, "pixmaps")],
  };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function plant(relative: string, body: Buffer | string = PNG): string {
  const file = path.join(tmp, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

describe("resolveIcon", () => {
  it("finds a themed name in hicolor by preferred size", () => {
    plant("icons/hicolor/48x48/apps/discord.png");
    plant("icons/hicolor/64x64/apps/discord.png", Buffer.from("BIG"));

    const hit = resolveIcon("discord", dirs);
    expect(hit?.contentType).toBe("image/png");
    // 64x64 outranks 48x48 in the preference order.
    expect(hit?.body.toString()).toBe("BIG");
  });

  it("falls back to scalable svg and then pixmaps", () => {
    plant("icons/hicolor/scalable/apps/gimp.svg", "<svg/>");
    expect(resolveIcon("gimp", dirs)?.contentType).toBe("image/svg+xml");

    plant("pixmaps/audacity.png");
    expect(resolveIcon("audacity", dirs)?.contentType).toBe("image/png");
  });

  it("serves an absolute path from the entry, but only image types", () => {
    const file = plant("somewhere/app.png");
    expect(resolveIcon(file, dirs)?.contentType).toBe("image/png");

    const script = plant("somewhere/evil.sh", "#!/bin/sh");
    expect(resolveIcon(script, dirs)).toBeUndefined();
  });

  it("refuses relative names with separators — neither spec form", () => {
    plant("icons/hicolor/64x64/apps/discord.png");
    expect(resolveIcon("../apps/discord", dirs)).toBeUndefined();
    expect(resolveIcon("hicolor/64x64/apps/discord", dirs)).toBeUndefined();
  });

  it("strips a stray extension from a themed name", () => {
    plant("icons/hicolor/64x64/apps/vlc.png");
    expect(resolveIcon("vlc.png", dirs)?.contentType).toBe("image/png");
  });

  it("a missing icon is honestly nothing", () => {
    expect(resolveIcon("no-such-icon", dirs)).toBeUndefined();
  });

  it("finds stock icons outside apps/ — categories, devices, status", () => {
    plant("icons/hicolor/64x64/categories/preferences-system-network.png");
    plant("icons/hicolor/64x64/devices/input-keyboard.png");
    plant("icons/hicolor/64x64/status/dialog-information.png");

    expect(resolveIcon("preferences-system-network", dirs)?.contentType).toBe("image/png");
    expect(resolveIcon("input-keyboard", dirs)?.contentType).toBe("image/png");
    expect(resolveIcon("dialog-information", dirs)?.contentType).toBe("image/png");
  });

  it("an application's own icon outranks a stock lookalike of the same name", () => {
    plant("icons/hicolor/64x64/categories/clash.png", Buffer.from("STOCK"));
    plant("icons/hicolor/48x48/apps/clash.png", Buffer.from("APP"));

    // apps/ wins across every size before any other context is consulted.
    expect(resolveIcon("clash", dirs)?.body.toString()).toBe("APP");
  });
});

describe("createIconSource", () => {
  const installed: DesktopEntryApp[] = [
    { name: "Discord", desktopId: "discord.desktop", icon: "discord" },
    { name: "Plain", desktopId: "plain.desktop" },
  ];

  it("resolves only ids the scan produced", () => {
    plant("icons/hicolor/64x64/apps/discord.png");
    const source = createIconSource(() => installed, dirs);

    expect(source("discord.desktop")?.contentType).toBe("image/png");
    expect(source("plain.desktop")).toBeUndefined();
    // An id the scan never produced resolves to nothing — the request
    // parameter can never choose a file by itself.
    expect(source("../../etc/passwd")).toBeUndefined();
  });
});
