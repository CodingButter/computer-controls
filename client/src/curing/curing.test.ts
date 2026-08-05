import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DesktopEntry } from "../platform/freedesktop/entries.ts";
import type { PermissionRow } from "../permissions/registry.ts";
import {
  ACCESSIBILITY_FLAG,
  cureChromiumApps,
  cureDesktopFile,
  cureExecLine,
  isChromiumExec,
  isCured,
} from "./curing.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function machine(): { systemDir: string; userDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cure-"));
  dirs.push(root);
  const systemDir = path.join(root, "usr-share-applications");
  const userDir = path.join(root, "local-share-applications");
  fs.mkdirSync(systemDir, { recursive: true });
  return { systemDir, userDir };
}

function install(dir: string, id: string, exec: string, extra = ""): DesktopEntry {
  // The id is the file's basename without the suffix, exactly as the scan
  // reports it; the override this produces has to land on the full filename.
  const file = path.join(dir, `${id}.desktop`);
  fs.writeFileSync(file, `[Desktop Entry]\nName=${id}\nExec=${exec}\n${extra}`, "utf8");
  return { id, name: id, source: file };
}

function row(over: Partial<PermissionRow> & { name: string }): PermissionRow {
  return { permitted: true, access: "interact", running: false, readable: false, ...over };
}

describe("Chromium detection", () => {
  it.each([
    ["/usr/bin/google-chrome-stable %U", true],
    ["/usr/bin/chromium --new-window", true],
    ["/usr/share/discord/Discord", true],
    ["/usr/bin/slack -s %U", true],
    ["env LANG=C /opt/brave.com/brave/brave-browser %U", true],
    ['"/opt/Obsidian/obsidian" %u', true],
    ["/usr/lib/firefox/firefox %u", false],
    ["gnome-terminal", false],
    ["nautilus --new-window %U", false],
    ["/usr/bin/gimp-2.10 %U", false],
  ])("reads %s as Chromium=%s", (exec, expected) => {
    expect(isChromiumExec(exec)).toBe(expected);
  });
});

describe("curing one Exec line", () => {
  it("puts the flag after the program, before the field codes", () => {
    expect(cureExecLine("/usr/bin/chromium %U")).toBe(
      `/usr/bin/chromium ${ACCESSIBILITY_FLAG} %U`,
    );
    expect(cureExecLine("env LANG=C /usr/bin/slack -s %U")).toBe(
      `env LANG=C /usr/bin/slack ${ACCESSIBILITY_FLAG} -s %U`,
    );
  });

  it("is idempotent — a line already carrying the flag is returned untouched", () => {
    const cured = `/usr/bin/chromium ${ACCESSIBILITY_FLAG} %U`;

    expect(isCured(cured)).toBe(true);
    expect(cureExecLine(cured)).toBe(cured);
  });

  it("cures every Exec line in the file, actions included", () => {
    const source = [
      "[Desktop Entry]",
      "Name=Chromium",
      "Exec=/usr/bin/chromium %U",
      "Actions=new-window;",
      "",
      "[Desktop Action new-window]",
      "Exec=/usr/bin/chromium --new-window",
    ].join("\n");

    const { text, changed } = cureDesktopFile(source);

    expect(changed).toBe(true);
    expect(text.match(new RegExp(ACCESSIBILITY_FLAG, "g"))).toHaveLength(2);
    expect(text).toContain("Name=Chromium");
  });

  it("leaves a non-Chromium file alone entirely", () => {
    const source = "[Desktop Entry]\nName=Files\nExec=nautilus --new-window %U\n";

    expect(cureDesktopFile(source)).toEqual({ text: source, changed: false, chromium: false });
  });
});

describe("curing the machine", () => {
  it("writes a user-scope override and never touches the system file", () => {
    const { systemDir, userDir } = machine();
    const discord = install(systemDir, "discord", "/usr/share/discord/Discord");
    const before = fs.readFileSync(discord.source, "utf8");

    const report = cureChromiumApps({
      rows: [row({ name: "Discord", desktopId: "discord", running: true })],
      entries: [discord],
      userApplicationsDir: userDir,
    });

    expect(report.cured).toEqual([{ name: "Discord", desktopId: "discord" }]);
    expect(fs.readFileSync(discord.source, "utf8")).toBe(before);
    expect(fs.readFileSync(path.join(userDir, "discord.desktop"), "utf8")).toContain(
      ACCESSIBILITY_FLAG,
    );
    // Running when cured: the flag reaches a process at launch, so this one waits.
    expect(report.needsRestart).toEqual(["Discord"]);
  });

  it("never cures an application the user has not permitted", () => {
    const { systemDir, userDir } = machine();
    const chrome = install(systemDir, "chrome", "/usr/bin/google-chrome-stable %U");

    const report = cureChromiumApps({
      rows: [row({ name: "chrome", desktopId: "chrome", permitted: false })],
      entries: [chrome],
      userApplicationsDir: userDir,
    });

    expect(report.cured).toEqual([]);
    expect(fs.existsSync(path.join(userDir, "chrome.desktop"))).toBe(false);
  });

  it("is idempotent across runs — the second cure writes nothing", () => {
    const { systemDir, userDir } = machine();
    const slack = install(systemDir, "slack", "/usr/bin/slack -s %U");
    const rows = [row({ name: "Slack", desktopId: "slack" })];

    cureChromiumApps({ rows, entries: [slack], userApplicationsDir: userDir });
    const target = path.join(userDir, "slack.desktop");
    const written = fs.readFileSync(target, "utf8");
    const stamp = fs.statSync(target).mtimeMs;

    const second = cureChromiumApps({
      rows,
      // The second run sees the override, exactly as a rescan would.
      entries: [{ ...slack, source: target }],
      userApplicationsDir: userDir,
    });

    expect(second.cured).toEqual([]);
    expect(second.alreadyCured).toEqual([{ name: "Slack", desktopId: "slack" }]);
    expect(fs.readFileSync(target, "utf8")).toBe(written);
    expect(fs.statSync(target).mtimeMs).toBe(stamp);
  });

  it("leaves permitted non-Chromium applications out of the report", () => {
    const { systemDir, userDir } = machine();
    const files = install(systemDir, "org.gnome.Nautilus", "nautilus --new-window %U");

    const report = cureChromiumApps({
      rows: [row({ name: "Files", desktopId: "org.gnome.Nautilus", running: true })],
      entries: [files],
      userApplicationsDir: userDir,
    });

    expect(report).toEqual({ cured: [], alreadyCured: [], needsRestart: [] });
    expect(fs.existsSync(userDir)).toBe(false);
  });

  it("names an already-cured application that is running unreadable — it predates its cure", () => {
    const { systemDir, userDir } = machine();
    const discord = install(
      systemDir,
      "discord",
      `/usr/share/discord/Discord ${ACCESSIBILITY_FLAG}`,
    );

    const report = cureChromiumApps({
      rows: [
        row({ name: "Discord", desktopId: "discord", running: true, readable: false }),
      ],
      entries: [discord],
      userApplicationsDir: userDir,
    });

    expect(report.alreadyCured).toHaveLength(1);
    expect(report.needsRestart).toEqual(["Discord"]);
  });
});
