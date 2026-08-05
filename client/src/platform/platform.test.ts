import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "vitest";

import { resolveClientConfig } from "../config.ts";
import { scanDesktopEntries } from "./freedesktop/entries.ts";
import { buildIconIndex, readThemeIcon } from "./freedesktop/icons.ts";
import { freedesktopPlatform } from "./freedesktop/index.ts";
import { resolveHubPlatform } from "./index.ts";
import { macosPaths, platformIdFor, windowsPaths } from "./unimplemented.ts";

/**
 * A freedesktop machine, built on disk.
 *
 * Every assertion below reads through the public port — hand the adapter an
 * environment, ask it what is installed — rather than through the parser it
 * happens to use. That is the whole bet of this seam: the day macOS gets an
 * adapter, these are the questions it has to answer too.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "comcon-platform-"));
const dataHome = path.join(home, ".local", "share");
const apps = path.join(dataHome, "applications");
const systemApps = path.join(home, "system", "applications");
const icons = path.join(dataHome, "icons", "hicolor");

fs.mkdirSync(apps, { recursive: true });
fs.mkdirSync(systemApps, { recursive: true });

function entry(dir: string, id: string, body: string): void {
  fs.writeFileSync(path.join(dir, `${id}.desktop`), body);
}

function icon(size: string, name: string, bytes: string): void {
  const dir = path.join(icons, size, "apps");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), bytes);
}

entry(apps, "atlas", "[Desktop Entry]\nType=Application\nName=Atlas\nIcon=atlas\n");
entry(systemApps, "atlas", "[Desktop Entry]\nType=Application\nName=Stale Atlas\nIcon=stale\n");
entry(systemApps, "beacon", "[Desktop Entry]\nType=Application\nName=Beacon\nIcon=/abs/none\n");
entry(systemApps, "hidden", "[Desktop Entry]\nType=Application\nName=Hidden\nNoDisplay=true\n");
entry(systemApps, "linkonly", "[Desktop Entry]\nType=Link\nName=Link\nURL=https://example.com\n");
entry(
  systemApps,
  "actions",
  // The action group repeats Name and Icon. A parser that read past the first
  // group would report "New Window" as the application's name.
  "[Desktop Entry]\nType=Application\nName=Actions\nIcon=actions\n" +
    "\n[Desktop Action new]\nName=New Window\nIcon=other\n",
);
fs.writeFileSync(path.join(systemApps, "notanentry.txt"), "ignored");

icon("16x16", "atlas.png", "small");
icon("64x64", "atlas.png", "large");
icon("scalable", "atlas.svg", "<svg/>");
icon("32x32", "actions.png", "actions-32");

const env: NodeJS.ProcessEnv = {
  HOME: home,
  XDG_DATA_HOME: dataHome,
  XDG_DATA_DIRS: path.join(home, "system"),
};

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

test("the scan lists what is installed, shadowing system entries with the user's", async () => {
  const found = await freedesktopPlatform(env).scanInstalled();

  // Sorted by display name, and only the entries a desktop would show.
  expect(found.map((app) => app.id)).toEqual(["actions", "atlas", "beacon"]);
  // The user's copy of atlas won: same id, nearer directory, and its name — not
  // the system copy's — is what a person sees.
  expect(found.find((app) => app.id === "atlas")?.name).toBe("Atlas");
  expect(found.find((app) => app.id === "actions")?.name).toBe("Actions");
});

test("a directory that does not exist costs the scan nothing", async () => {
  const found = await scanDesktopEntries([path.join(home, "nowhere"), apps]);

  expect(found.map((app) => app.id)).toEqual(["atlas"]);
});

test("an icon resolves to the largest picture the theme has, scalable first", async () => {
  const found = await freedesktopPlatform(env).icons("atlas");

  expect(found?.mediaType).toBe("image/svg+xml");
  expect(new TextDecoder().decode(found?.bytes)).toBe("<svg/>");
});

test("without a scalable version the biggest raster wins, not the first found", async () => {
  const found = await freedesktopPlatform(env).icons("actions");

  expect(found?.mediaType).toBe("image/png");
  expect(new TextDecoder().decode(found?.bytes)).toBe("actions-32");
});

test("a missing icon is absent, not an error", async () => {
  const platform = freedesktopPlatform(env);

  // Named in the entry, absent from disk; and an id with no entry at all.
  await expect(platform.icons("beacon")).resolves.toBeUndefined();
  await expect(platform.icons("ghost")).resolves.toBeUndefined();
});

test("an entry cannot point the icon reader out of the icon directories", async () => {
  fs.writeFileSync(path.join(home, "secret.png"), "secret");
  entry(apps, "escapee", "[Desktop Entry]\nType=Application\nName=Escapee\nIcon=../../secret\n");

  await expect(freedesktopPlatform(env).icons("escapee")).resolves.toBeUndefined();
  // The traversal is refused at the icon name. An absolute path is still
  // honoured — that is what the key means — but only for something shaped like
  // an image: the media type comes from the extension, and a value with none
  // resolves to nothing however readable the file is.
  const index = await buildIconIndex([icons]);
  await expect(readThemeIcon(path.join(home, "secret.png"), index)).resolves.toMatchObject({
    mediaType: "image/png",
  });
  fs.writeFileSync(path.join(home, "id_rsa"), "PRIVATE KEY");
  await expect(readThemeIcon(path.join(home, "id_rsa"), index)).resolves.toBeUndefined();
});

test("a theme linked in from elsewhere is still searched", async () => {
  // Whole themes symlinked into a second root are ordinary on a machine with a
  // system theme and a user override; refusing to follow them would lose real
  // icons rather than protect anything.
  const real = path.join(home, "real-theme", "48x48", "apps");
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, "linked.png"), "via-symlink");
  fs.symlinkSync(path.join(home, "real-theme"), path.join(icons, "..", "linked-theme"));

  const found = await readThemeIcon("linked", await buildIconIndex([path.join(icons, "..")]));
  expect(new TextDecoder().decode(found?.bytes)).toBe("via-symlink");
});

test("an application id cannot walk out of the applications directories", async () => {
  const platform = freedesktopPlatform(env);

  await expect(platform.icons("../../secret")).resolves.toBeUndefined();
  await expect(platform.icons("")).resolves.toBeUndefined();
});

test("XDG base directories decide where the hub may write", () => {
  const paths = freedesktopPlatform({ ...env, XDG_STATE_HOME: "/state" }).paths;

  // Named where it is set, and the spec's own default where it is not.
  expect(paths.state).toBe(path.join("/state", "mastracode-desktop"));
  expect(paths.config).toBe(path.join(home, ".config", "mastracode-desktop"));
});

test("each OS is named, and everything unrecognised follows freedesktop", () => {
  expect(platformIdFor("darwin")).toBe("macos");
  expect(platformIdFor("win32")).toBe("windows");
  expect(platformIdFor("linux")).toBe("freedesktop");
  expect(platformIdFor("freebsd")).toBe("freedesktop");
});

test("macOS and Windows already know where they would write", () => {
  expect(macosPaths({ HOME: "/Users/jamie" }).config).toBe(
    "/Users/jamie/Library/Application Support/mastracode-desktop",
  );
  // Settings roam between a person's machines; the audit log deliberately does not.
  const windows = windowsPaths({ APPDATA: "R:\\Roaming", LOCALAPPDATA: "L:\\Local" });
  expect(windows.config).toContain("R:\\Roaming");
  expect(windows.state).toContain("L:\\Local");
});

test("an OS without a wave yet boots, reports an empty machine, and admits why", async () => {
  const platform = resolveHubPlatform({ HOME: "/Users/jamie" }, "darwin");

  expect(platform.id).toBe("macos");
  // The pair is the point: no applications, and a flag saying that is because
  // nobody has written the scanner rather than because the machine is bare.
  await expect(platform.scanInstalled()).resolves.toEqual([]);
  expect(platform.supports.installedScan).toBe(false);
  expect(freedesktopPlatform(env).supports.installedScan).toBe(true);
});

test("the hub resolves its adapter once, at boot, off the same environment", () => {
  const config = resolveClientConfig({ ...env, COMCON_CLIENT_PORT: "0" });

  expect(config.platform.id).toBe(platformIdFor(process.platform));
  expect(config.platform.paths.state).toContain("mastracode-desktop");
});
