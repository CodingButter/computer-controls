import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

import desktopControl from "../../plugin/src/index.ts";

/**
 * The hub, booted for real: the entry module constructs Mastra, finalizes the
 * controller, and listens. Everything asserted below is read off that running
 * process rather than off a rebuilt copy of it.
 */
let baseUrl: string;
let close: () => Promise<void>;
let health: { tools: string[]; desktopScope: string };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "comcon-client-"));

beforeAll(async () => {
  process.env.COMCON_CLIENT_ROOT = root;
  process.env.COMCON_CLIENT_PORT = "0";
  const entry = await import("./index.ts");
  baseUrl = await entry.listening;
  close = () => new Promise<void>((resolve) => entry.server.close(() => resolve()));
  health = (await fetch(`${baseUrl}/api/health`).then((r) => r.json())) as typeof health;
}, 120_000);

afterAll(async () => {
  await close?.();
  fs.rmSync(root, { recursive: true, force: true });
});

test("test_client_boots_and_serves_the_ui", async () => {
  const page = await fetch(baseUrl);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  const html = await page.text();
  expect(html).toContain("<title>computer controls</title>");

  // The page's logic is one fetch away rather than inline, so the boot proof
  // has to follow it: a browser that cannot load this module gets a page that
  // does nothing, and the HTML alone would not say so.
  expect(html).toContain('src="/app.js"');
  const script = await fetch(`${baseUrl}/app.js`);
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toContain("javascript");
  expect(await script.text()).toContain("/api/chat");

  // A path the page owns rather than a file on disk still lands on the page:
  // one process serving one SPA, which is the whole point of the static lane.
  const deepLink = await fetch(`${baseUrl}/threads/whatever`);
  expect(deepLink.status).toBe(200);
  expect(await deepLink.text()).toContain("<title>computer controls</title>");
});

test("the sign-in surface serves through the booted hub, not just its own module", async () => {
  // This is the wiring the auth module cannot test for itself: the entry
  // module has to actually mount it, or every route below is a 404 dressed
  // as the SPA fallback.
  const flows = await fetch(`${baseUrl}/api/oauth/flows`);
  expect(flows.status).toBe(200);
  const body = (await flows.json()) as { providers: Array<{ provider: string }> };
  const providers = body.providers.map((p) => p.provider);
  // The offer is the runtime's own provider registry, not a hand-written
  // shortlist: anything this hub can route a model to can be given a key here.
  // The three the product signs into lead it.
  expect(providers.slice(0, 3)).toEqual(["anthropic", "openai", "google"]);
  expect(providers).toContain("deepseek");
  expect(providers.length).toBeGreaterThan(3);

  const settings = await fetch(`${baseUrl}/settings/accounts`);
  expect(settings.status).toBe(200);
  expect(settings.headers.get("content-type")).toContain("text/html");

  // Read-only routes against the real store: whatever this machine's
  // connection state is, nothing token-shaped may leave.
  expect(JSON.stringify(body)).not.toMatch(/access|refresh|sk-|eyJ/);
});

test("the voice routes serve through the booted hub, not just their own module", async () => {
  // Same wiring lesson as the sign-in surface: the module can pass every test
  // it owns and still be a 404 in the running process. The probe route must
  // answer through the real hub, whatever this machine's credential state is:
  // a list of speakers when voice is on, an empty list when it is off.
  const speakers = await fetch(`${baseUrl}/api/agents/session/voice/speakers`);
  expect(speakers.status).toBe(200);
  expect(Array.isArray(await speakers.json())).toBe(true);

  // And health must say which of those two worlds the browser is in.
  const voiceHealth = (await fetch(`${baseUrl}/api/health`).then((r) => r.json())) as {
    voice?: { enabled: boolean; reason?: string };
  };
  expect(voiceHealth.voice).toBeDefined();
  if (!voiceHealth.voice!.enabled) {
    expect(voiceHealth.voice!.reason).toMatch(/OpenAI|Google/);
  }

  // The list of mouths a person may pick from, read off the running process
  // against whatever this machine actually has. On a machine with no voice
  // account it is empty — that is the "no key, no offer" rule holding at boot,
  // not a failure — and either way no credential may appear in it.
  const offered = await fetch(`${baseUrl}/api/voice/providers`);
  expect(offered.status).toBe(200);
  const offeredBody = (await offered.json()) as {
    providers: Array<{ provider: string; usable: boolean }>;
  };
  expect(Array.isArray(offeredBody.providers)).toBe(true);
  expect(JSON.stringify(offeredBody)).not.toMatch(/access|refresh|sk-|eyJ/);

  // Whatever is offered must be a provider this hub actually knows.
  for (const entry of offeredBody.providers) {
    expect(["openai", "gemini-live"]).toContain(entry.provider);
  }

  // The settings section renders that list rather than a copy of it, so the
  // page has to point at this route or the two answers can drift apart.
  const settings = await fetch(`${baseUrl}/settings/accounts`).then((r) => r.text());
  expect(settings).toContain("/api/voice/providers");
});

test("the orb serves as a second face through the booted hub", async () => {
  // The orb page is a separate face over the same session, so it has to be
  // reachable as a page and as a lane. Neither is provable from the orb modules'
  // own tests: those build the app directly and would pass with nothing mounted.
  const page = await fetch(`${baseUrl}/orb`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toContain('src="/orb.js"');

  const script = await fetch(`${baseUrl}/orb.js`);
  expect(script.status).toBe(200);
  expect(await script.text()).toContain("/api/orb");

  // The status route answers whatever this machine's credential and hardware
  // state is — enabled with a gate state, or off with a reason a person can act
  // on. A hub with no Google key is the expected state today.
  const status = (await fetch(`${baseUrl}/api/orb/status`).then((r) => r.json())) as {
    enabled: boolean;
    reason?: string;
    gate?: string;
  };
  const orbHealth = (await fetch(`${baseUrl}/api/health`).then((r) => r.json())) as {
    orb?: { enabled: boolean; reason?: string };
  };
  expect(orbHealth.orb).toBeDefined();
  expect(orbHealth.orb!.enabled).toBe(status.enabled);
  if (!status.enabled) {
    expect(status.reason).toMatch(/\S/);
    expect(orbHealth.orb!.reason).toBe(status.reason);
  }
});

test("test_desktop_tools_are_minted_at_observe_scope", async () => {
  const minted = health.tools.filter((name) => name.startsWith("desktop_")).sort();
  expect(health.desktopScope).toBe("observe");
  expect(minted.length).toBeGreaterThan(0);

  // The plugin owns the tool-to-operation-class map, so the expected sets are
  // asked of the plugin rather than copied here, where they would rot silently.
  const observeTools = await mintedAt("observe");
  const everyTool = await mintedAt("observe,edit,activate,submit,destructive");

  expect(minted).toEqual(observeTools);
  // If the client ever mounted the plugin above observe this would stop being a
  // strict subset — which is the failure the test exists to catch.
  expect(observeTools.length).toBeLessThan(everyTool.length);
  for (const name of minted) expect(everyTool).toContain(name);
});

async function mintedAt(scope: string): Promise<string[]> {
  const pluginDir = path.resolve(import.meta.dirname, "..", "..", "plugin");
  const tools = await desktopControl.tools({
    cwd: pluginDir,
    scope: "project",
    pluginDir,
    config: { scope },
  });
  return Object.keys(tools).sort();
}
