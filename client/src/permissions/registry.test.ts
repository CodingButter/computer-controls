import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Census } from "./daemon.ts";
import type { DesktopEntryApp } from "./desktop-entries.ts";
import { createPermissionRegistry, deriveAccess, derivePermitted } from "./registry.ts";

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
    await registry().setAccess("Discord", "off");

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

    const view = await registry().setAccess("Discord", "interact");
    expect(view.applications.find((row: { name: string }) => row.name === "Discord")?.permitted).toBe(
      true,
    );
    let written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      scopes: { applications: string[] };
    };
    expect(written.scopes.applications).toEqual(["Discord"]);

    await registry().setAccess("Discord", "off");
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

    await registry().setAccess("GIMP", "interact");

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
    const permitted = await gnomeish.setAccess("Files", "interact");
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
    const revoked = await gnomeish.setAccess("org.gnome.Nautilus", "off");
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

    await closedApp.setAccess("Files", "interact");
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

/**
 * The class column is a prediction of `security.Ceiling.classes_for`, so it
 * mirrors that function's semantics rather than inventing kinder ones: an
 * absent entry is the general answer standing, overlapping patterns intersect,
 * and the ladder is filled in on the way out and then capped.
 */
describe("deriveAccess, the page's reading of the class map", () => {
  const per = (
    applications: string[],
    applicationClasses: Record<string, string[]>,
    globalClasses: string[] = ["observe", "edit", "activate"],
  ) =>
    deriveAccess("Discord", "per-application", applications, [], applicationClasses, globalClasses);

  test("no entry at all is interact: the general answer stands", () => {
    expect(per(["Discord"], {})).toEqual({ access: "interact" });
  });

  test("observe alone is view-only", () => {
    expect(per(["Discord"], { Discord: ["observe"] })).toEqual({
      access: "view",
      classes: ["observe"],
    });
  });

  test("an unpermitted application is off whatever the class map says", () => {
    // The list is the outer question. A class entry for an application that is
    // not permitted describes a door that is shut.
    expect(per([], { Discord: ["observe"] })).toEqual({ access: "off" });
  });

  test("interact implies view: a named activate fills the ladder in beneath it", () => {
    expect(per(["Discord"], { Discord: ["activate"] })).toEqual({
      access: "interact",
      classes: ["observe", "edit", "activate"],
    });
  });

  test("the implication is capped by the global ceiling, never widened past it", () => {
    // `activate` inside one application cannot outrun an operationClasses that
    // stops at `edit` everywhere.
    expect(per(["Discord"], { Discord: ["activate"] }, ["observe", "edit"])).toEqual({
      access: "interact",
      classes: ["observe", "edit"],
    });
  });

  test("two patterns naming one application agree on the narrower, in either order", () => {
    const narrowFirst = per(["Discord"], { Discord: ["observe"], disc: ["activate"] });
    const vagueFirst = per(["Discord"], { disc: ["activate"], Discord: ["observe"] });
    expect(narrowFirst).toEqual({ access: "view", classes: ["observe"] });
    // The same answer whichever way the user happened to order their own file.
    expect(vagueFirst).toEqual(narrowFirst);
  });

  test("a shape the page cannot express is custom, carrying what is really in force", () => {
    expect(
      per(["Discord"], { Discord: ["edit"] }, ["observe", "edit", "activate"]),
    ).toEqual({ access: "custom", classes: ["observe", "edit"] });
  });

  test("an empty entry is a thing the user typed: nothing permitted inside", () => {
    expect(per(["Discord"], { Discord: [] })).toEqual({ access: "custom", classes: [] });
  });

  test("matching is casefolded and padding-tolerant, as the ceiling's is", () => {
    expect(per(["Discord"], { " DISCORD ": ["observe"] })).toEqual({
      access: "view",
      classes: ["observe"],
    });
  });
});

describe("writing the three states through to the file", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "perm-access-"));
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
  const perApplication = (extra: Record<string, unknown> = {}) =>
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        scopes: { permissionsMode: "per-application", applications: ["Discord"], ...extra },
      }),
    );
  const readScopes = () =>
    (
      JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        scopes: { applications: string[]; applicationClasses?: Record<string, string[]> };
      }
    ).scopes;

  test("view-only permits the application and caps it in one write", async () => {
    perApplication();

    const view = await registry().setAccess("Discord", "view");

    const scopes = readScopes();
    expect(scopes.applications).toContain("Discord");
    expect(scopes.applicationClasses).toEqual({ Discord: ["observe"] });
    // And the page agrees with the file it just wrote.
    expect(view.applications.find((row) => row.name === "Discord")?.access).toBe("view");
  });

  test("the file keeps the user's own word, not the ladder filled in", async () => {
    // `observe` is what was chosen; the implication happens where the answer is
    // read. A file that said "observe, edit, activate" would mean something
    // different the day the user narrows operationClasses.
    perApplication();
    await registry().setAccess("Discord", "view");
    expect(readScopes().applicationClasses).toEqual({ Discord: ["observe"] });
  });

  test("interact removes the cap rather than writing one that restates the ceiling", async () => {
    perApplication({
      applicationClasses: { Discord: ["observe"] },
      operationClasses: ["observe", "edit", "activate"],
    });

    const view = await registry().setAccess("Discord", "interact");

    // The key is deleted rather than left as an empty object: the daemon reads
    // the two identically, so `{}` would be this page's litter in a file the
    // user opens and reads.
    expect(readScopes().applicationClasses).toBeUndefined();
    expect(view.applications.find((row) => row.name === "Discord")?.access).toBe("interact");
  });

  test("turning an application off takes its cap with it", async () => {
    // A leftover pattern would go on capping the application from behind the
    // control that just changed it — and would silently reappear as view-only
    // the next time it was permitted.
    perApplication({ applicationClasses: { Discord: ["observe"] } });

    await registry().setAccess("Discord", "off");

    const scopes = readScopes();
    expect(scopes.applications).not.toContain("Discord");
    expect(scopes.applicationClasses).toBeUndefined();
  });

  test("a cap on one application is left alone when another is changed", async () => {
    perApplication({
      applications: ["Discord", "GIMP"],
      applicationClasses: { Discord: ["observe"] },
    });

    await registry().setAccess("GIMP", "view");

    expect(readScopes().applicationClasses).toEqual({
      Discord: ["observe"],
      GIMP: ["observe"],
    });
  });

  test("every name a row answers to is capped, and later uncapped, together", async () => {
    // "Files" and "org.gnome.Nautilus" are one application wearing two names.
    // Capping one and not the other would leave the door open behind the row.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ scopes: { permissionsMode: "per-application", applications: [] } }),
    );
    const gnomeish = createPermissionRegistry({
      configPath,
      readCensus: async () => ({ reachable: true, applications: [] }) as Census,
      scanInstalled: () => [
        { name: "Files", desktopId: "org.gnome.Nautilus.desktop", exec: "nautilus" },
      ],
    });

    await gnomeish.setAccess("Files", "view");
    expect(readScopes().applicationClasses).toEqual({
      Files: ["observe"],
      "org.gnome.Nautilus": ["observe"],
    });

    await gnomeish.setAccess("Files", "interact");
    expect(readScopes().applicationClasses).toBeUndefined();
  });

  test("a write preserves a hand-written cap on an application the page never touched", async () => {
    perApplication({
      applications: ["Discord", "GIMP"],
      applicationClasses: { Slack: ["observe", "edit"] },
      operationClasses: ["observe", "edit", "activate"],
    });

    await registry().setAccess("GIMP", "view");

    const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      scopes: Record<string, unknown>;
    };
    expect(written.scopes.applicationClasses).toEqual({
      Slack: ["observe", "edit"],
      GIMP: ["observe"],
    });
    expect(written.scopes.operationClasses).toEqual(["observe", "edit", "activate"]);
  });

  test("the transition out of open mode carries the caps that were already there", async () => {
    // Open mode has no list, so the first choice writes one. A cap the user had
    // hand-written must survive the moment the page takes the file over.
    fs.writeFileSync(configPath, JSON.stringify({ scopes: { applicationClasses: { GIMP: ["observe"] } } }));

    await registry().setAccess("Discord", "view");

    const scopes = readScopes();
    expect(scopes.applications).toContain("GIMP");
    expect(scopes.applicationClasses).toEqual({ GIMP: ["observe"], Discord: ["observe"] });
  });
});

/**
 * The global `operationClasses` is the outermost of the three questions, and
 * the page does not own it — the settings surface does. What the page owes is
 * an honest reading of it: `security.Ceiling.from_config` treats an absent
 * `operationClasses` as `observe` alone, so a page that read the absence as
 * "everything" would draw a desktop full of interactive applications while the
 * daemon refused every click.
 */
describe("the global ceiling bounds what the page can offer", () => {
  const permitted = (globalClasses: string[], applicationClasses: Record<string, string[]> = {}) =>
    deriveAccess("Discord", "per-application", ["Discord"], [], applicationClasses, globalClasses);

  test("an absent operationClasses is observe-only, and the row says view", () => {
    expect(permitted([])).toEqual({ access: "view", classes: ["observe"] });
  });

  test("an operationClasses of observe alone is the same answer, said out loud", () => {
    expect(permitted(["observe"])).toEqual({ access: "view", classes: ["observe"] });
  });

  test("one rung above observe is enough for an application to be interactive", () => {
    expect(permitted(["observe", "edit"])).toEqual({ access: "interact" });
  });

  test("a view-only cap under an observe-only ceiling is still just view", () => {
    // Both say the same thing; the page must not report it as a contradiction.
    expect(permitted([], { Discord: ["observe"] })).toEqual({ access: "view", classes: ["observe"] });
  });

  test("the view reports the ceiling with its ladder filled in", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perm-ceiling-"));
    const configPath = path.join(dir, "config.json");
    try {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ scopes: { permissionsMode: "per-application", operationClasses: ["activate"] } }),
      );
      const view = await createPermissionRegistry({
        configPath,
        readCensus: async () => ({ reachable: true, applications: [] }) as Census,
        scanInstalled: () => [],
      }).view();
      expect(view.ceiling).toEqual(["observe", "edit", "activate"]);

      fs.writeFileSync(configPath, JSON.stringify({ scopes: { permissionsMode: "per-application" } }));
      const bare = await createPermissionRegistry({
        configPath,
        readCensus: async () => ({ reachable: true, applications: [] }) as Census,
        scanInstalled: () => [],
      }).view();
      expect(bare.ceiling).toEqual(["observe"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
