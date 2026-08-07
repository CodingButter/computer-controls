import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import type { CredentialStore, ProviderConnection } from "../auth/credentials.ts";
import { DECLARED_PACK } from "../model-pack.ts";
import { buildModelPacksApp } from "./routes.ts";
import { ModelPacksService } from "./service.ts";
import { FilePackStore, MODEL_PACKS_FILE, MemoryPackStore } from "./store.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-packs-"));
  file = path.join(dir, MODEL_PACKS_FILE);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A credential store that knows only which providers are connected — which is all this surface asks. */
function credentials(connected: string[]): CredentialStore {
  const status = (provider: string): ProviderConnection => ({
    provider,
    name: provider,
    connected: connected.includes(provider),
    ...(connected.includes(provider) ? { method: "api-key" as const } : {}),
  });
  return {
    connectOAuth: () => {},
    connectApiKey: () => {},
    disconnect: () => {},
    status,
    statuses: () => connected.map(status),
  };
}

const service = (connected: string[], store = new FilePackStore(dir)) =>
  new ModelPacksService({ store, credentials: credentials(connected), env: {} });

const app = (connected: string[], store?: FilePackStore) =>
  buildModelPacksApp(service(connected, store));

type View = {
  active: { id: string; name: string; thinking: string; models: Record<string, string> };
  thinkingTier: string;
  tiers: string[];
  overrides: Record<string, string>;
  packs: { id: string; name: string; source: string; active: boolean; selectable: boolean; reason?: string }[];
  providers: { provider: string; connected: boolean; models: string[] }[];
};

async function view(connected: string[], store?: FilePackStore): Promise<View> {
  const response = await app(connected, store).request("/api/model-packs");
  expect(response.status).toBe(200);
  return (await response.json()) as View;
}

test("with no file, the declared pack is the active one and the built-ins are all listed", async () => {
  const body = await view(["anthropic"]);

  expect(body.active.id).toBe(DECLARED_PACK.id);
  expect(body.active.thinking).toBe(DECLARED_PACK.models.standard);
  expect(body.thinkingTier).toBe("standard");
  expect(body.tiers).toEqual(["minimal", "standard", "heavy"]);
  expect(body.packs.filter((pack) => pack.source === "built-in").length).toBeGreaterThanOrEqual(3);
  expect(body.packs.find((pack) => pack.id === DECLARED_PACK.id)?.active).toBe(true);
  expect(fs.existsSync(file)).toBe(false);
});

test("a pack whose provider has no key is offered with the reason it cannot be picked", async () => {
  const body = await view(["anthropic"]);

  const anthropic = body.packs.find((pack) => pack.id === DECLARED_PACK.id);
  expect(anthropic?.selectable).toBe(true);
  expect(anthropic?.reason).toBeUndefined();

  const openai = body.packs.find((pack) => pack.id === "computer-controls-openai");
  expect(openai?.selectable).toBe(false);
  // The reason names the account that is missing rather than saying "unavailable".
  expect(openai?.reason).toMatch(/openai/i);

  const refused = await app(["anthropic"]).request("/api/model-packs/active", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "computer-controls-openai" }),
  });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toMatch(/openai/i);
  // Refused means unchanged: nothing was written on the way to saying no.
  expect(fs.existsSync(file)).toBe(false);
});

test("picking a pack writes the choice and the next read answers with it", async () => {
  const store = new FilePackStore(dir);
  const response = await app(["anthropic", "google"], store).request("/api/model-packs/active", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "computer-controls-google" }),
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as View;
  expect(body.active.id).toBe("computer-controls-google");
  expect(body.active.thinking).toMatch(/^google\//);

  // The choice survives the process: a new service over the same directory
  // reads the file rather than the build's declaration.
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
    activeId: "computer-controls-google",
  });
  expect((await view(["anthropic", "google"])).active.id).toBe("computer-controls-google");
});

test("an unknown pack is refused by name", async () => {
  const response = await app(["anthropic"]).request("/api/model-packs/active", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "nope" }),
  });

  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: string }).error).toContain("nope");
});

test("a pack a person makes can be picked, and deleting the active one falls back to the declared pack", async () => {
  const made = await app(["anthropic"]).request("/api/model-packs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Cheap day",
      models: {
        minimal: "anthropic/claude-haiku-4-5",
        standard: "anthropic/claude-haiku-4-5",
        heavy: "anthropic/claude-sonnet-4-6",
      },
    }),
  });
  expect(made.status).toBe(200);
  const custom = ((await made.json()) as View).packs.find((pack) => pack.source === "custom");
  expect(custom).toMatchObject({ name: "Cheap day", id: "cheap-day", selectable: true });

  const picked = await app(["anthropic"]).request("/api/model-packs/active", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "cheap-day" }),
  });
  expect(((await picked.json()) as View).active.thinking).toBe("anthropic/claude-haiku-4-5");

  const deleted = await app(["anthropic"]).request("/api/model-packs/cheap-day", {
    method: "DELETE",
  });
  expect(deleted.status).toBe(200);
  const after = (await deleted.json()) as View;
  expect(after.packs.some((pack) => pack.source === "custom")).toBe(false);
  expect(after.active.id).toBe(DECLARED_PACK.id);
});

test("a built-in cannot be deleted, and the refusal says how to get an editable copy", async () => {
  const response = await app(["anthropic"]).request(`/api/model-packs/${DECLARED_PACK.id}`, {
    method: "DELETE",
  });

  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: string }).error).toMatch(/duplicate/i);
});

test("a banned model is refused at the field rather than at the next turn", async () => {
  const response = await app(["anthropic"]).request("/api/model-packs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Fable",
      models: {
        minimal: "anthropic/claude-haiku-4-5",
        standard: "anthropic/claude-fable-5",
        heavy: "anthropic/claude-opus-4-6",
      },
    }),
  });

  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: string }).error).toMatch(/does not run/);
});

test("a half-typed model id is refused with the shape it should have had", async () => {
  const response = await app(["anthropic"]).request("/api/model-packs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Half",
      models: { minimal: "haiku", standard: "anthropic/claude-sonnet-4-6", heavy: "" },
    }),
  });

  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: string }).error).toContain("provider/model");
});

test("a nameless pack is refused, and PUT without an id is a bad request", async () => {
  const nameless = await app(["anthropic"]).request("/api/model-packs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ models: { minimal: "a/b", standard: "a/b", heavy: "a/b" } }),
  });
  expect(nameless.status).toBe(409);

  const idless = await app(["anthropic"]).request("/api/model-packs/active", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(idless.status).toBe(400);
});

test("a file nobody can parse is refused with the reason, not replaced", async () => {
  fs.writeFileSync(file, "{ not json");

  const response = await app(["anthropic"]).request("/api/model-packs");
  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: string }).error).toMatch(/not valid JSON/);
  // The unreadable file is still there: a person can fix what they wrote.
  expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
});

test("keys this hub does not own survive a write", async () => {
  fs.writeFileSync(file, JSON.stringify({ somethingElse: { keep: true }, custom: [] }));

  await app(["anthropic", "google"]).request("/api/model-packs/active", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "computer-controls-google" }),
  });

  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
    somethingElse: { keep: true },
    activeId: "computer-controls-google",
  });
});

test("the offerings carry every connected provider's models and no credential", async () => {
  const body = await view(["anthropic"]);

  const anthropic = body.providers.find((row) => row.provider === "anthropic");
  expect(anthropic?.connected).toBe(true);
  expect(anthropic?.models).toContain("anthropic/claude-sonnet-4-6");
  // The page must never be offered a model the boot check would refuse.
  expect(anthropic?.models).not.toContain("anthropic/claude-fable-5");
  expect(body.providers.some((row) => !row.connected)).toBe(true);
  expect(JSON.stringify(body)).not.toMatch(/apiKey|accessToken|refreshToken/);
});

test("a tier pinned by the environment is named, and the pin outranks the chosen pack", () => {
  const store = new MemoryPackStore({ custom: [], activeId: "computer-controls-google" });
  const pinned = new ModelPacksService({
    store,
    credentials: credentials(["anthropic", "google"]),
    env: { COMCON_MODEL_STANDARD: "anthropic/claude-opus-4-6" },
  });

  const body = pinned.view();
  expect(body.overrides).toEqual({ standard: "COMCON_MODEL_STANDARD" });
  // The operator's pin wins, and the page is told which variable did it rather
  // than being left to explain a model nobody picked.
  expect(body.active.thinking).toBe("anthropic/claude-opus-4-6");
  expect(body.active.models.minimal).toMatch(/^google\//);
});

test("a chosen pack that no longer exists resolves to the declared pack", () => {
  const store = new MemoryPackStore({ custom: [], activeId: "a-pack-from-a-past-build" });
  const stale = new ModelPacksService({ store, credentials: credentials(["anthropic"]), env: {} });

  expect(stale.activePack().id).toBe(DECLARED_PACK.id);
  expect(stale.view().active.id).toBe(DECLARED_PACK.id);
});
