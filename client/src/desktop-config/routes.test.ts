import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DESKTOP_CONFIG_PATH, buildDesktopConfigApp, type DesktopConfigView } from "./routes.ts";

let dir: string;
let file: string;
let app: ReturnType<typeof buildDesktopConfigApp>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "desktop-config-routes-"));
  file = path.join(dir, "config.json");
  app = buildDesktopConfigApp({ file });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = async (): Promise<DesktopConfigView> => {
  const response = await app.request(DESKTOP_CONFIG_PATH);
  expect(response.status).toBe(200);
  return (await response.json()) as DesktopConfigView;
};

const save = (edits: Record<string, unknown>) =>
  app.request(DESKTOP_CONFIG_PATH, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ edits }),
  });

/**
 * The three depths, as the fields each one puts on screen. Taken from the
 * ruling in docs/10-distribution-and-dashboard.md: lenses over one object, so a
 * lens is a subset of keys and nothing more. Voice and the orb belong to Easy
 * too, but they are hub state rather than daemon configuration and do not live
 * in this file.
 */
const EASY = ["scopes.permissionsMode"] as const;
const STANDARD = [
  ...EASY,
  "scopes.operationClasses",
  "scopes.idleExpirySeconds",
  "scopes.confirmClasses",
] as const;
const ADVANCED = [...STANDARD, "sensitiveApplications", "audit", "auditPath"] as const;

/** What a lens would send back when a person opens it and saves without touching anything. */
function echo(view: DesktopConfigView, lens: readonly string[]): Record<string, unknown> {
  const scopes = (view.config.scopes ?? {}) as Record<string, unknown>;
  const edits: Record<string, unknown> = {};
  for (const key of lens) {
    const value = key.startsWith("scopes.") ? scopes[key.slice("scopes.".length)] : view.config[key];
    if (value !== undefined) edits[key] = value;
  }
  return edits;
}

const RICH_CONFIG = {
  scopes: {
    permissionsMode: "per-application",
    operationClasses: ["observe", "edit"],
    applications: ["discord", "nautilus"],
    blockedApplications: ["bitwarden", "keepassxc"],
    confirmClasses: ["submit", "destructive"],
    idleExpirySeconds: 900,
  },
  sensitiveApplications: ["bitwarden"],
  audit: true,
  somethingNoLensKnowsAbout: { written: "by hand" },
};

describe("one object, three depths", () => {
  it("answers every lens from the same route and the same object", async () => {
    await writeFile(file, JSON.stringify(RICH_CONFIG));
    const view = await read();
    // There is no per-lens endpoint to diverge: Easy and Advanced are handed
    // the identical object and differ only in what they choose to draw.
    expect(view.config).toEqual(RICH_CONFIG);
    expect(view.exists).toBe(true);
    expect(view.path).toBe(file);
  });

  it("loses nothing when a person walks Easy to Advanced and back", async () => {
    await writeFile(file, JSON.stringify(RICH_CONFIG));
    const before = await read();

    for (const lens of [EASY, STANDARD, ADVANCED, STANDARD, EASY]) {
      const response = await save(echo(before, lens));
      expect(response.status).toBe(200);
    }

    // The acceptance rule from the ruling, executed literally: configure,
    // switch depths, diff the configuration object, expect no change. Including
    // the two keys no lens owns and the one no lens has heard of.
    expect((await read()).config).toEqual(RICH_CONFIG);
  });

  it("keeps a value a shallower lens cannot draw", async () => {
    await writeFile(file, JSON.stringify(RICH_CONFIG));
    const before = await read();
    // Easy cannot show idle expiry or the confirmation classes. Saving from
    // Easy must not therefore mean consenting to lose them.
    expect((await save(echo(before, EASY))).status).toBe(200);
    const after = await read();
    expect((after.config.scopes as Record<string, unknown>).idleExpirySeconds).toBe(900);
    expect((after.config.scopes as Record<string, unknown>).confirmClasses).toEqual([
      "submit",
      "destructive",
    ]);
  });

  it("tells a lens the daemon's defaults, so an unset key is not drawn as empty", async () => {
    const view = await read();
    expect(view.exists).toBe(false);
    expect(view.defaults).toEqual({
      permissionsMode: "open",
      operationClasses: ["observe"],
      confirmClasses: ["submit", "destructive"],
      idleExpirySeconds: 1800,
      audit: true,
    });
    expect(view.vocabulary.permissionsModes).toEqual(["open", "per-application"]);
  });
});

describe("saving", () => {
  it("writes a first configuration on a machine that has none", async () => {
    const response = await save({ "scopes.permissionsMode": "per-application" });
    expect(response.status).toBe(200);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      scopes: { permissionsMode: "per-application" },
    });
  });

  it("returns the whole object it just wrote, not the edit", async () => {
    await writeFile(file, JSON.stringify(RICH_CONFIG));
    const body = (await (await save({ audit: false })).json()) as DesktopConfigView;
    expect(body.config).toEqual({ ...RICH_CONFIG, audit: false });
  });

  it("refuses to write through the permissions registry", async () => {
    const response = await save({ "scopes.applications": ["discord"] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/does not own|not a setting/);
  });

  it("refuses a value the daemon would refuse to start on", async () => {
    const response = await save({ "scopes.operationClasses": ["observe", "teleport"] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/unknown operation class/);
  });

  it("refuses a body that is not a set of edits", async () => {
    expect((await save([] as unknown as Record<string, unknown>)).status).toBe(400);
  });
});

describe("a malformed file already on disk", () => {
  const BROKEN = '{"scopes": {"applications": ["discord"],}}';

  it("is reported to the reader rather than shown as empty", async () => {
    await writeFile(file, BROKEN);
    const response = await app.request(DESKTOP_CONFIG_PATH);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/is not valid JSON/);
  });

  it("stops a save instead of being overwritten by it", async () => {
    await writeFile(file, BROKEN);
    const response = await save({ audit: false });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/Nothing was written/);
    // The whole point: a trailing comma costs a person a refusal, not the
    // allowlist they typed by hand.
    expect(await readFile(file, "utf8")).toBe(BROKEN);
  });
});
