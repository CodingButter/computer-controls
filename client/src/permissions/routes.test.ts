import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import type { Census } from "./daemon.ts";
import type { DesktopEntryApp } from "./desktop-entries.ts";
import { createPermissionRegistry } from "./registry.ts";
import { buildPermissionsApp } from "./routes.ts";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "perm-routes-"));
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

const app = () =>
  buildPermissionsApp(
    createPermissionRegistry({
      configPath,
      readCensus: async () => census,
      scanInstalled: () => installed,
    }),
  );

test("GET merges the census and the launcher scan, each row carrying its permitted flag", async () => {
  fs.writeFileSync(
    configPath,
    JSON.stringify({ scopes: { permissionsMode: "per-application", applications: ["Discord"] } }),
  );

  const response = await app().request("/api/permissions");
  expect(response.status).toBe(200);
  const view = (await response.json()) as {
    mode: string;
    daemon: { reachable: boolean };
    applications: { name: string; permitted: boolean; running: boolean; readable: boolean }[];
  };

  expect(view.mode).toBe("per-application");
  expect(view.daemon).toEqual({ reachable: true });
  const byName = Object.fromEntries(view.applications.map((row) => [row.name, row]));
  expect(byName.Discord).toMatchObject({ permitted: true, running: true, readable: true });
  expect(byName["Google-chrome"]).toMatchObject({ permitted: false, running: true, readable: false });
  expect(byName.GIMP).toMatchObject({ permitted: false, running: false });
});

test("PUT writes per-application mode with exact names, atomically", async () => {
  const response = await app().request("/api/permissions/GIMP", {
    method: "PUT",
    body: JSON.stringify({ access: "interact" }),
    headers: { "content-type": "application/json" },
  });
  expect(response.status).toBe(200);

  // One write carried the mode and the list together — a config observed
  // between the daemon's reads never has one without the other.
  const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    scopes: { permissionsMode: string; applications: string[] };
  };
  expect(written.scopes.permissionsMode).toBe("per-application");
  expect(written.scopes.applications).toContain("GIMP");
  // Exact names only — nothing fragment-shaped that the ceiling's substring
  // match would widen.
  for (const name of written.scopes.applications) {
    expect(["Discord", "Google-chrome", "GIMP"]).toContain(name);
  }

  // And no temp file left beside it.
  expect(fs.readdirSync(dir)).toEqual(["config.json"]);
});

test("a PUT never touches scopes keys it does not own", async () => {
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      scopes: {
        permissionsMode: "per-application",
        applications: [],
        operationClasses: ["observe", "edit", "activate"],
        confirmClasses: ["submit"],
        audit: true,
      },
    }),
  );

  await app().request("/api/permissions/Discord", {
    method: "PUT",
    body: JSON.stringify({ access: "interact" }),
    headers: { "content-type": "application/json" },
  });

  const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    scopes: Record<string, unknown>;
  };
  expect(written.scopes.operationClasses).toEqual(["observe", "edit", "activate"]);
  expect(written.scopes.confirmClasses).toEqual(["submit"]);
  expect(written.scopes.audit).toBe(true);
});

test("a malformed config is refused with the reason, never silently overwritten", async () => {
  fs.writeFileSync(configPath, "{ this is not json");

  const get = await app().request("/api/permissions");
  expect(get.status).toBe(409);
  expect(((await get.json()) as { error: string }).error).toContain(configPath);

  const put = await app().request("/api/permissions/Discord", {
    method: "PUT",
    body: JSON.stringify({ access: "interact" }),
    headers: { "content-type": "application/json" },
  });
  expect(put.status).toBe(409);

  // The broken file survived exactly as the user left it.
  expect(fs.readFileSync(configPath, "utf8")).toBe("{ this is not json");
});

test("a PUT without one of the three states is a 400, not a guess", async () => {
  // `custom` included deliberately: it is a shape the file can hold and this
  // route cannot be asked for, because honouring it would mean inventing which
  // classes the caller meant.
  for (const body of [
    JSON.stringify({ access: "yes" }),
    JSON.stringify({ access: "custom" }),
    JSON.stringify({ permitted: true }),
    JSON.stringify({}),
    "not json",
  ]) {
    const response = await app().request("/api/permissions/Discord", {
      method: "PUT",
      body,
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(400);
  }
  expect(fs.existsSync(configPath)).toBe(false);
});

test("the icon route streams a resolved icon and 404s honestly otherwise", async () => {
  const withIcons = buildPermissionsApp(
    createPermissionRegistry({
      configPath,
      readCensus: async () => census,
      scanInstalled: () => installed,
    }),
    (desktopId) =>
      desktopId === "discord.desktop"
        ? { body: Buffer.from("PNGBYTES"), contentType: "image/png" }
        : undefined,
  );

  const hit = await withIcons.request("/api/permissions/icon/discord.desktop");
  expect(hit.status).toBe(200);
  expect(hit.headers.get("content-type")).toBe("image/png");
  expect(await hit.text()).toBe("PNGBYTES");

  const miss = await withIcons.request("/api/permissions/icon/gimp.desktop");
  expect(miss.status).toBe(404);

  // Without an icon source at all, the route still answers rather than throws.
  const none = await app().request("/api/permissions/icon/discord.desktop");
  expect(none.status).toBe(404);
});
