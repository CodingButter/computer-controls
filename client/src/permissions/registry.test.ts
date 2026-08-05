import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Census } from "./daemon.ts";
import type { DesktopEntryApp } from "./desktop-entries.ts";
import { createPermissionRegistry, derivePermitted } from "./registry.ts";

/**
 * The permitted column is a prediction of the daemon's ceiling, so the truth
 * table here mirrors the ceiling's own semantics — including the substring
 * near-collisions that make "write exact names" a rule and not a preference.
 */
describe("derivePermitted", () => {
  test("open mode with nothing named withholds nothing", () => {
    expect(derivePermitted("Discord", "open", [], [])).toBe(true);
    expect(derivePermitted("anything at all", "open", [], [])).toBe(true);
  });

  test("blocked wins in every mode", () => {
    expect(derivePermitted("Bitwarden", "open", [], ["bitwarden"])).toBe(false);
    expect(derivePermitted("Bitwarden", "per-application", ["Bitwarden"], ["bitwarden"])).toBe(
      false,
    );
  });

  test("per-application with an empty list is the narrowest scope there is", () => {
    expect(derivePermitted("Discord", "per-application", [], [])).toBe(false);
  });

  test("per-application permits the named and not the unknown", () => {
    expect(derivePermitted("Discord", "per-application", ["Discord"], [])).toBe(true);
    expect(derivePermitted("Slack", "per-application", ["Discord"], [])).toBe(false);
  });

  test("substring matches both directions, exactly as the ceiling does", () => {
    // A fragment in the list covers the whole name — the page must show the
    // daemon's truth, not a stricter fiction.
    expect(derivePermitted("Discord", "per-application", ["disc"], [])).toBe(true);
    // And the other direction: a short census name against a longer entry.
    expect(derivePermitted("disc", "per-application", ["Discord"], [])).toBe(true);
    // But an unrelated name stays out.
    expect(derivePermitted("Slack", "per-application", ["disc"], [])).toBe(false);
  });

  test("matching is casefolded", () => {
    expect(derivePermitted("DISCORD", "per-application", ["discord"], [])).toBe(true);
  });
});

describe("the registry against a real config file", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "perm-registry-"));
    configPath = path.join(dir, "config.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const census: Census = {
    reachable: true,
    applications: [
      { name: "Discord", running: true, readable: true },
      { name: "Google-chrome", running: true, readable: false },
    ],
  };
  const installed: DesktopEntryApp[] = [
    { name: "Discord", desktopId: "discord.desktop", exec: "Discord" },
    { name: "GIMP", desktopId: "gimp.desktop", exec: "gimp-2.10" },
  ];

  const registry = () =>
    createPermissionRegistry({
      configPath,
      readCensus: async () => census,
      scanInstalled: () => installed,
    });

  test("an absent config reads as open mode: everything permitted", async () => {
    const view = await registry().view();
    expect(view.mode).toBe("open");
    expect(view.applications.every((row) => row.permitted)).toBe(true);
  });

  test("the transition: the first toggle on a fresh config flips the mode and seeds the list in one write", async () => {
    // Open mode, nothing on disk. Denying one application must not silently
    // revoke the rest of the desktop, so the write that introduces
    // per-application mode carries every application the page could see.
    await registry().setPermitted("Discord", false);

    const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      scopes: { permissionsMode: string; applications: string[] };
    };
    expect(written.scopes.permissionsMode).toBe("per-application");
    expect(written.scopes.applications).not.toContain("Discord");
    // The rest of the visible desktop survived the transition, by exact name.
    expect(written.scopes.applications).toContain("Google-chrome");
    expect(written.scopes.applications).toContain("GIMP");
  });

  test("toggling writes exact names, and toggling back removes them", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ scopes: { permissionsMode: "per-application", applications: [] } }),
    );

    const view = await registry().setPermitted("Discord", true);
    expect(view.applications.find((row) => row.name === "Discord")?.permitted).toBe(true);
    let written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      scopes: { applications: string[] };
    };
    expect(written.scopes.applications).toEqual(["Discord"]);

    await registry().setPermitted("Discord", false);
    written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      scopes: { applications: string[] };
    };
    expect(written.scopes.applications).toEqual([]);
  });

  test("a write preserves every key it does not own", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        somethingTheUserWrote: { keep: "me" },
        scopes: {
          permissionsMode: "per-application",
          applications: [],
          operationClasses: ["observe", "edit"],
          blockedApplications: ["bitwarden"],
          idleExpirySeconds: 3600,
        },
      }),
    );

    await registry().setPermitted("GIMP", true);

    const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>;
    expect(written.somethingTheUserWrote).toEqual({ keep: "me" });
    expect(written.scopes.operationClasses).toEqual(["observe", "edit"]);
    expect(written.scopes.blockedApplications).toEqual(["bitwarden"]);
    expect(written.scopes.idleExpirySeconds).toBe(3600);
    expect(written.scopes.applications).toEqual(["GIMP"]);
  });

  test("the merged view distinguishes running-readable, running-unreadable, and merely installed", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        scopes: { permissionsMode: "per-application", applications: ["Discord"] },
      }),
    );

    const view = await registry().view();
    const byName = Object.fromEntries(view.applications.map((row) => [row.name, row]));

    expect(byName.Discord).toMatchObject({
      permitted: true,
      running: true,
      readable: true,
      desktopId: "discord.desktop",
    });
    expect(byName["Google-chrome"]).toMatchObject({
      permitted: false,
      running: true,
      readable: false,
    });
    expect(byName.GIMP).toMatchObject({ permitted: false, running: false, readable: false });
  });

  test("a census name and a launcher name joined by the desktop-file id are one row", async () => {
    // GNOME's launcher says "Files"; the bus says "org.gnome.Nautilus". The
    // desktop-file id stem is the thread connecting them, and the page must
    // show one application with one toggle, not two half-truths.
    const gnomeish = createPermissionRegistry({
      configPath,
      readCensus: async () =>
        ({
          reachable: true,
          applications: [{ name: "org.gnome.Nautilus", running: true, readable: true }],
        }) as Census,
      scanInstalled: () => [
        { name: "Files", desktopId: "org.gnome.Nautilus.desktop", exec: "nautilus" },
      ],
    });

    const view = await gnomeish.view();
    expect(view.applications).toHaveLength(1);
    expect(view.applications[0]).toMatchObject({
      name: "Files",
      running: true,
      readable: true,
      desktopId: "org.gnome.Nautilus.desktop",
      censusName: "org.gnome.Nautilus",
    });
  });

  test("toggling a unified row writes the census name and un-permitting removes every identity", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ scopes: { permissionsMode: "per-application", applications: [] } }),
    );
    const gnomeish = createPermissionRegistry({
      configPath,
      readCensus: async () =>
        ({
          reachable: true,
          applications: [{ name: "org.gnome.Nautilus", running: true, readable: true }],
        }) as Census,
      scanInstalled: () => [
        { name: "Files", desktopId: "org.gnome.Nautilus.desktop", exec: "nautilus" },
      ],
    });

    // Permitting by the display name writes the name the daemon matches on.
    const permitted = await gnomeish.setPermitted("Files", true);
    expect(permitted.applications[0]?.permitted).toBe(true);
    let written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      scopes: { applications: string[] };
    };
    expect(written.scopes.applications).toEqual(["org.gnome.Nautilus"]);

    // Un-permitting by EITHER name closes the door entirely — a leftover
    // identity would keep it open behind the toggle.
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        scopes: {
          permissionsMode: "per-application",
          applications: ["Files", "org.gnome.Nautilus"],
        },
      }),
    );
    const revoked = await gnomeish.setPermitted("org.gnome.Nautilus", false);
    expect(revoked.applications[0]?.permitted).toBe(false);
    written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      scopes: { applications: string[] };
    };
    expect(written.scopes.applications).toEqual([]);
  });

  test("a unified row's permitted column is predicted from the census name alone", async () => {
    // The daemon matches ITS name — "org.gnome.Nautilus" — against the list.
    // "Files" being on the list permits nothing the daemon can see, and the
    // page saying otherwise would be a green toggle over a refused door.
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        scopes: { permissionsMode: "per-application", applications: ["Files"] },
      }),
    );
    const gnomeish = createPermissionRegistry({
      configPath,
      readCensus: async () =>
        ({
          reachable: true,
          applications: [{ name: "org.gnome.Nautilus", running: true, readable: true }],
        }) as Census,
      scanInstalled: () => [
        { name: "Files", desktopId: "org.gnome.Nautilus.desktop", exec: "nautilus" },
      ],
    });

    const view = await gnomeish.view();
    expect(view.applications[0]?.permitted).toBe(false);
  });

  test("permitting a not-running app writes the id stem alongside the launcher name", async () => {
    // While the app is closed the census name is unknowable; the stem is the
    // best prediction of what the daemon will call it when it starts.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ scopes: { permissionsMode: "per-application", applications: [] } }),
    );
    const closedApp = createPermissionRegistry({
      configPath,
      readCensus: async () => ({ reachable: true, applications: [] }) as Census,
      scanInstalled: () => [
        { name: "Files", desktopId: "org.gnome.Nautilus.desktop", exec: "nautilus" },
      ],
    });

    await closedApp.setPermitted("Files", true);
    const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      scopes: { applications: string[] };
    };
    expect(written.scopes.applications.sort()).toEqual(["Files", "org.gnome.Nautilus"]);
  });

  test("an unreachable daemon is an answer, not an error", async () => {
    const offline = createPermissionRegistry({
      configPath,
      readCensus: async () => ({ reachable: false, reason: "not running" }) as Census,
      scanInstalled: () => installed,
    });

    const view = await offline.view();
    expect(view.daemon).toEqual({ reachable: false, reason: "not running" });
    // Installed applications still render; nothing shows as running.
    expect(view.applications.map((row) => row.name).sort()).toEqual(["Discord", "GIMP"]);
    expect(view.applications.every((row) => !row.running)).toBe(true);
  });
});
