import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import type { Census } from "./daemon.ts";
import type { InstalledApplication } from "../platform/index.ts";
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
const installed: InstalledApplication[] = [
  { id: "discord", name: "Discord" },
  { id: "gimp", name: "GIMP" },
];

const app = () =>
  buildPermissionsApp(
    createPermissionRegistry({
      configPath,
      readCensus: async () => census,
      scanInstalled: async () => installed,
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

const emptyReport = () => ({ cured: [], alreadyCured: [], needsRestart: [] });

const withCure = (cure: () => Promise<ReturnType<typeof emptyReport>>) =>
  buildPermissionsApp(
    createPermissionRegistry({
      configPath,
      readCensus: async () => census,
      scanInstalled: async () => installed,
    }),
    undefined,
    cure,
  );

const grant = (built: ReturnType<typeof withCure>, access: string) =>
  built.request("/api/permissions/Google-chrome", {
    method: "PUT",
    body: JSON.stringify({ access }),
    headers: { "content-type": "application/json" },
  });

test("granting access cures the launchers before it answers", async () => {
  for (const access of ["view", "interact"]) {
    fs.rmSync(configPath, { force: true });
    let calls = 0;
    const response = await grant(
      withCure(async () => {
        calls += 1;
        return emptyReport();
      }),
      access,
    );

    expect(response.status).toBe(200);
    // Exactly once, and before the response: a page that has been told the
    // grant landed must be able to trust that the launcher matches it.
    expect(calls).toBe(1);
  }
});

test("revoking cures nothing", async () => {
  let calls = 0;
  const response = await grant(
    withCure(async () => {
      calls += 1;
      return emptyReport();
    }),
    "off",
  );

  expect(response.status).toBe(200);
  expect(calls).toBe(0);
});

test("a grant survives a cure that fails", async () => {
  const response = await grant(
    withCure(async () => {
      throw new Error("read-only filesystem");
    }),
    "interact",
  );

  // The permission was written; only the launcher rewrite failed. Answering
  // with an error would tell the person their grant did not land, and it did.
  expect(response.status).toBe(200);
  const view = (await response.json()) as { applications: { name: string; permitted: boolean }[] };
  expect(view.applications.find((row) => row.name === "Google-chrome")?.permitted).toBe(true);
  expect(JSON.parse(fs.readFileSync(configPath, "utf8")).scopes.applications).toContain(
    "Google-chrome",
  );
});

test("a machine that cannot cure still grants", async () => {
  const response = await grant(app() as ReturnType<typeof withCure>, "view");
  expect(response.status).toBe(200);
});

test("the icon route streams a resolved icon and 404s honestly otherwise", async () => {
  const withIcons = buildPermissionsApp(
    createPermissionRegistry({
      configPath,
      readCensus: async () => census,
      scanInstalled: async () => installed,
    }),
    async (applicationId) =>
      applicationId === "discord"
        ? { bytes: new TextEncoder().encode("PNGBYTES"), mediaType: "image/png" }
        : undefined,
  );

  const hit = await withIcons.request("/api/permissions/icon/discord");
  expect(hit.status).toBe(200);
  expect(hit.headers.get("content-type")).toBe("image/png");
  expect(await hit.text()).toBe("PNGBYTES");

  const miss = await withIcons.request("/api/permissions/icon/gimp");
  expect(miss.status).toBe(404);

  // Without an icon source at all, the route still answers rather than throws.
  const none = await app().request("/api/permissions/icon/discord");
  expect(none.status).toBe(404);
});
