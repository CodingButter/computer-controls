import path from "node:path";
import { expect, test } from "vitest";

import { buildApp } from "./app.ts";
import type { ClientStatus } from "./app.ts";
import { UNBUILT_DASHBOARD_PAGE, readUiAsset } from "./ui.ts";

const uiRoot = path.resolve(import.meta.dirname, "..", "public");
const dashboardRoot = path.resolve(import.meta.dirname, "fixtures", "dashboard-out");

const status = async (): Promise<ClientStatus> => ({
  tools: [],
  desktopScope: "observe",
  plugins: { admitted: [], refused: [] },
  model: { pack: "test", thinking: "test", tiers: {} },
  platform: { id: "freedesktop", supports: { installedScan: true, icons: true, shortcutCuring: true, autostart: true } },
});

const appWithDashboard = () =>
  buildApp({ chat: async () => ({ text: "", status: "ok" }), uiRoot, dashboardRoot, status });

test("no path escapes either root", () => {
  // Each of these names a real file outside the served directory. None of
  // them may ever come back as that file's bytes, however the path is spelled
  // and whichever root is asked.
  for (const attempt of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "//../package.json"]) {
    for (const root of [uiRoot, dashboardRoot]) {
      const body = readUiAsset(root, attempt)?.body.toString() ?? "";
      expect(body).not.toContain("computer-controls-client");
    }
  }
});

test("the hub's own root no longer answers unknown paths when asked without the fallback", () => {
  // public/ keeps its named pages and assets but gave up "/": a miss must
  // fall through to the dashboard rather than answer with a page that moved.
  expect(readUiAsset(uiRoot, "/threads/abc", { spaFallback: false })).toBeUndefined();
  expect(readUiAsset(uiRoot, "/", { spaFallback: false })).toBeUndefined();
});

test("the dashboard owns / and the SPA fallback", async () => {
  const app = appWithDashboard();

  const home = await app.request("/");
  expect(home.status).toBe(200);
  expect(await home.text()).toContain("dashboard-fixture-root");

  // A path the dashboard owns rather than a file on disk still lands on it.
  const deep = await app.request("/permissions");
  expect(await deep.text()).toContain("dashboard-fixture-root");

  // Real dashboard assets serve as themselves, typed as themselves.
  const asset = await app.request("/asset.css");
  expect(asset.headers.get("content-type")).toContain("text/css");
});

test("chat moved to /chat and its module still resolves from the root", async () => {
  const app = appWithDashboard();

  const chat = await app.request("/chat");
  expect(chat.status).toBe(200);
  expect(await chat.text()).toContain("<title>computer controls</title>");

  // The chat page's script src is an absolute root path; the rename must not
  // have broken it.
  const script = await app.request("/app.js");
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toContain("javascript");
});

test("the orb and its vendored module still serve from the hub's own root", async () => {
  const app = appWithDashboard();

  for (const [route, marker] of [
    ["/orb", "<canvas"],
    ["/orb.js", "orb"],
    ["/vendor/three.module.js", "three"],
  ] as const) {
    const response = await app.request(route);
    expect(response.status, `${route} must keep serving`).toBe(200);
    expect((await response.text()).toLowerCase()).toContain(marker);
  }
});

test("an unbuilt dashboard is refused with the build command, never a blank 404", async () => {
  const app = buildApp({
    chat: async () => ({ text: "", status: "ok" }),
    uiRoot,
    dashboardRoot: path.join(dashboardRoot, "does-not-exist"),
    status,
  });

  const home = await app.request("/");
  expect(home.status).toBe(503);
  const body = await home.text();
  expect(body).toContain("cd dashboard && pnpm install && pnpm build");
  expect(body).toContain("/chat");

  // And the same when no root was configured at all.
  const bare = buildApp({ chat: async () => ({ text: "", status: "ok" }), uiRoot, status });
  const bareHome = await bare.request("/");
  expect(bareHome.status).toBe(503);
  expect(await bareHome.text()).toBe(UNBUILT_DASHBOARD_PAGE);
});
