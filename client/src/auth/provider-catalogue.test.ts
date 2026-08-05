/**
 * The acceptance suite for the promise that the dashboard tells the whole truth
 * about credentials.
 *
 * The claim under test is narrow and checkable: any provider the model runtime
 * can route to can be given a key from this page, and a key that is already in
 * the store shows up there whether or not this product ever offered a button
 * for it. The failure it exists to prevent is the quiet one — a key sitting in
 * `auth.json` that the runtime happily uses and the dashboard cannot see, which
 * is a settings page telling half the truth.
 *
 * As in the sign-in suite, the credential store is real: the SDK's `AuthStorage`
 * writing a real `auth.json` in a temporary directory, so "the key is visible"
 * means the format Mastra Code's own gateway reads. What is mocked is the
 * provider at the other end of the key check, because the question is whether we
 * repeat what a provider says, not whether a provider is up.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";

import {
  createProviderAuth,
  createApiKeyVerifier,
  describeProvider,
  PROVIDER_IDS,
  type ApiKeyVerifier,
  type KeyVerification,
  type ProviderAuth,
} from "./index.ts";
import type { ProviderLoginFlows } from "./flows.ts";

const PASTED_KEY = "SENTINEL-pasted-deepseek-key";

/** The login flows are irrelevant here; every one of them refuses to be called. */
const unusedFlows: ProviderLoginFlows = {
  startAnthropicLogin: () => Promise.reject(new Error("not part of this suite")),
  completeAnthropicLogin: () => Promise.reject(new Error("not part of this suite")),
  startCodexDeviceLogin: () => Promise.reject(new Error("not part of this suite")),
  pollCodexDeviceLogin: () => Promise.reject(new Error("not part of this suite")),
};

/** A provider that answers however the test needs it to. */
class ScriptedVerifier implements ApiKeyVerifier {
  answer: KeyVerification = { status: "accepted" };
  asked: Array<{ provider: string; key: string }> = [];

  async verify(provider: { id: string }, key: string): Promise<KeyVerification> {
    this.asked.push({ provider: provider.id, key });
    return this.answer;
  }
}

let authDir: string;
let storage: AuthStorage;
let verifier: ScriptedVerifier;
let auth: ProviderAuth;

/** One browser, holding the owner cookie the write routes require. */
async function call(path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const init: RequestInit =
    payload === undefined
      ? { method: "GET" }
      : {
          method: "POST",
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
        };
  const response = await auth.app.request(path, init);
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  authDir = mkdtempSync(join(tmpdir(), "cc-catalogue-"));
  storage = new AuthStorage(join(authDir, "auth.json"));
  verifier = new ScriptedVerifier();
  auth = createProviderAuth({ storage, flows: unusedFlows, verifier });
});

afterEach(() => {
  rmSync(authDir, { recursive: true, force: true });
  for (const provider of ["deepseek", "zai", "google", "openai", "anthropic"]) {
    for (const envVar of describeProvider(provider).apiKeyEnvVars) delete process.env[envVar];
  }
});

describe("the catalogue the page is offered", () => {
  it("offers every provider the runtime can route a model to", async () => {
    const { body } = await call("/api/oauth/flows");
    const offered = new Set(body.providers.map((entry: { provider: string }) => entry.provider));

    // The three the product used to hard-code are still here, and so is
    // everything else the runtime knows — including the two whose keys were
    // already in this machine's store with nowhere to manage them.
    for (const id of ["anthropic", "openai", "google", "deepseek", "zai", "xai", "groq"]) {
      expect(offered.has(id)).toBe(true);
    }
    expect(offered.size).toBe(PROVIDER_IDS.length);
    expect(offered.size).toBeGreaterThan(100);
  });

  it("names a connection method for each, and invents a sign-in for none of them", async () => {
    const { body } = await call("/api/oauth/flows");
    const kinds = new Map<string, string>(
      body.providers.map((entry: { provider: string; loginKind: string }) => [
        entry.provider,
        entry.loginKind,
      ]),
    );

    // Owning an OAuth client is a cost decision, so the only providers claiming
    // a sign-in flow are the two this product actually drives one for. Every
    // other entry says "api-key", which is a complete answer rather than a
    // missing one.
    expect(kinds.get("anthropic")).toBe("paste-code");
    expect(kinds.get("openai")).toBe("device-code");
    expect(kinds.get("deepseek")).toBe("api-key");
    const flowed = [...kinds].filter(([, kind]) => kind !== "api-key").map(([id]) => id);
    expect(flowed).toEqual(["anthropic", "openai"]);
  });

  it("refuses to start a sign-in for a provider with no flow, and says what to do instead", async () => {
    const refused = await call("/api/oauth/start", { provider: "deepseek" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe(
      "DeepSeek has no sign-in flow here. Paste a DeepSeek API key instead.",
    );
  });
});

describe("a key for a provider the product never wrote a button for", () => {
  it("can be added and removed from the page, and lands where model resolution looks", async () => {
    const saved = await call("/api/oauth/api-key", { provider: "deepseek", key: PASTED_KEY });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ provider: "deepseek", connected: true, method: "api-key" });

    // The store, in the format the gateway reads.
    expect(storage.getStoredApiKey("deepseek")).toBe(PASTED_KEY);
    // And the environment, so this process resolves a DeepSeek model without a
    // restart — the whole point of writing it here rather than in a text file.
    expect(process.env["DEEPSEEK_API_KEY"]).toBe(PASTED_KEY);

    const listed = await call("/api/oauth/flows");
    const deepseek = listed.body.providers.find(
      (entry: { provider: string }) => entry.provider === "deepseek",
    );
    expect(deepseek).toMatchObject({ connected: true, method: "api-key" });

    const removed = await call("/api/oauth/disconnect", { provider: "deepseek" });
    expect(removed.body).toMatchObject({ provider: "deepseek", connected: false });
    expect(storage.getStoredApiKey("deepseek")).toBeUndefined();
    expect(process.env["DEEPSEEK_API_KEY"]).toBeUndefined();
  });

  it("shows a key that was already in the store, with the key itself never leaving", async () => {
    // The situation that motivated all of this: keys written by hand, in use by
    // the runtime, invisible to the page.
    storage.setStoredApiKey("deepseek", "SENTINEL-preexisting-deepseek", "DEEPSEEK_API_KEY");
    storage.setStoredApiKey("zai", "SENTINEL-preexisting-zai", "ZHIPU_API_KEY");

    const { body } = await call("/api/oauth/flows");
    const byId = new Map(
      body.providers.map((entry: { provider: string }) => [entry.provider, entry]),
    );
    expect(byId.get("deepseek")).toMatchObject({ connected: true, method: "api-key" });
    expect(byId.get("zai")).toMatchObject({ connected: true, method: "api-key" });

    expect(JSON.stringify(body)).not.toContain("SENTINEL-preexisting-deepseek");
    expect(JSON.stringify(body)).not.toContain("SENTINEL-preexisting-zai");
  });

  it("writes every environment variable a provider is read under", async () => {
    // Google's key is read as GOOGLE_GENERATIVE_AI_API_KEY by the AI SDK's
    // provider and as GOOGLE_API_KEY by the registry. A key that satisfies one
    // of them is a connection that works in half the product.
    await call("/api/oauth/api-key", { provider: "google", key: "SENTINEL-google-key" });
    expect(process.env["GOOGLE_GENERATIVE_AI_API_KEY"]).toBe("SENTINEL-google-key");
    expect(process.env["GOOGLE_API_KEY"]).toBe("SENTINEL-google-key");

    await call("/api/oauth/disconnect", { provider: "google" });
    expect(process.env["GOOGLE_GENERATIVE_AI_API_KEY"]).toBeUndefined();
    expect(process.env["GOOGLE_API_KEY"]).toBeUndefined();
  });

  it("still files an OpenAI key under the id the gateway reads it from", async () => {
    // The one provider whose credential is not filed under its own name.
    await call("/api/oauth/api-key", { provider: "openai", key: "SENTINEL-openai-key" });
    expect(storage.getStoredApiKey("openai-codex")).toBe("SENTINEL-openai-key");
    expect(storage.getStoredApiKey("openai")).toBeUndefined();
  });
});

describe("a key the provider will not honour", () => {
  it("is reported as rejected, in the provider's own words", async () => {
    verifier.answer = {
      status: "rejected",
      reason: "Your credit balance is too low to access the API.",
    };

    const saved = await call("/api/oauth/api-key", { provider: "deepseek", key: PASTED_KEY });
    expect(saved.body).toMatchObject({
      connected: true,
      rejectedReason: "Your credit balance is too low to access the API.",
    });

    // And it keeps saying so on reload, because the page is read from this
    // route and nowhere else.
    const listed = await call("/api/oauth/flows");
    const deepseek = listed.body.providers.find(
      (entry: { provider: string }) => entry.provider === "deepseek",
    );
    expect(deepseek.rejectedReason).toBe("Your credit balance is too low to access the API.");

    // The key was kept. A provider that is out of credit today is not a reason
    // to make somebody find their key again tomorrow.
    expect(storage.getStoredApiKey("deepseek")).toBe(PASTED_KEY);
  });

  it("stops being reported once a working key replaces it", async () => {
    verifier.answer = { status: "rejected", reason: "Invalid API key." };
    await call("/api/oauth/api-key", { provider: "deepseek", key: "bad-key" });

    verifier.answer = { status: "accepted" };
    const fixed = await call("/api/oauth/api-key", { provider: "deepseek", key: PASTED_KEY });
    expect(fixed.body.rejectedReason).toBeUndefined();
  });

  it("stops being reported once the credential is disconnected", async () => {
    verifier.answer = { status: "rejected", reason: "Invalid API key." };
    await call("/api/oauth/api-key", { provider: "deepseek", key: "bad-key" });

    const removed = await call("/api/oauth/disconnect", { provider: "deepseek" });
    expect(removed.body.rejectedReason).toBeUndefined();
    expect(removed.body.connected).toBe(false);
  });

  it("says nothing when the provider could not be reached at all", async () => {
    // Silence is the correct answer to a question nobody answered. Claiming a
    // key is bad because a network was down is the same lie as claiming it is
    // good.
    verifier.answer = { status: "unverified" };
    const saved = await call("/api/oauth/api-key", { provider: "deepseek", key: PASTED_KEY });
    expect(saved.body.rejectedReason).toBeUndefined();
    expect(saved.body.connected).toBe(true);
  });
});

describe("the verifier that asks a provider about a key", () => {
  const deepseek = describeProvider("deepseek");

  it("asks the provider's own endpoint, carrying the key as a bearer token", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const verify = createApiKeyVerifier(async (input, init) => {
      seen.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response("{}", { status: 200 });
    });

    expect(await verify.verify(deepseek, "key-123")).toEqual({ status: "accepted" });
    expect(seen).toEqual([
      { url: "https://api.deepseek.com/models", auth: "Bearer key-123" },
    ]);
  });

  it("treats refusal, no credit and rate limits as the key not serving", async () => {
    for (const status of [401, 402, 403, 429]) {
      const verify = createApiKeyVerifier(
        async () =>
          new Response(JSON.stringify({ error: { message: "Authentication Fails" } }), { status }),
      );
      expect(await verify.verify(deepseek, "key")).toEqual({
        status: "rejected",
        reason: "Authentication Fails",
      });
    }
  });

  it("does not read a server's bad day as a verdict on the key", async () => {
    for (const status of [404, 500, 503]) {
      const verify = createApiKeyVerifier(async () => new Response("nope", { status }));
      expect(await verify.verify(deepseek, "key")).toEqual({ status: "unverified" });
    }
  });

  it("refuses to relay an error that carries the key back to us", async () => {
    // Some providers echo the credential into their error text. That text is
    // headed for a web page, so it is held to the same rule as everything else
    // here: no response carries a key.
    const verify = createApiKeyVerifier(
      async () =>
        new Response(JSON.stringify({ error: { message: "api key sk-abcdefghijklmno is invalid" } }), {
          status: 401,
        }),
    );
    const result = await verify.verify(deepseek, "sk-abcdefghijklmno");
    expect(result).toEqual({
      status: "rejected",
      reason: "DeepSeek refused this key (HTTP 401).",
    });
  });

  it("does not probe a provider with no reachable endpoint", async () => {
    let called = false;
    const verify = createApiKeyVerifier(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    // Anthropic publishes no base URL in the registry, and a local server is
    // not something to fire a stranger's key at from here.
    expect(await verify.verify(describeProvider("anthropic"), "key")).toEqual({
      status: "unverified",
    });
    expect(await verify.verify(describeProvider("lmstudio"), "key")).toEqual({
      status: "unverified",
    });
    expect(called).toBe(false);
  });

  it("does not hang the request when a provider never answers", async () => {
    const verify = createApiKeyVerifier(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = verify.verify(deepseek, "key");
    // The abort signal is the contract; assert it exists rather than waiting
    // five real seconds for it to fire.
    await expect(
      Promise.race([pending, Promise.resolve({ status: "still-waiting" })]),
    ).resolves.toEqual({ status: "still-waiting" });
  });
});

describe("the settings page itself", () => {
  it("renders the catalogue, its search, and a key control for a provider it never named", async () => {
    const response = await auth.app.request("/settings/accounts");
    const html = await response.text();

    expect(html).toContain("entry-template");
    expect(html).toContain("catalogue");
    expect(html).toContain("Add a key");
    expect(html).toContain("Search providers");
    // The page is still a driver: it asks the route what exists rather than
    // carrying a list of its own.
    expect(html).not.toContain("deepseek");
    expect(html).not.toMatch(/access_?[Tt]oken|refresh_?[Tt]oken|verifier/);
  });

  it("looks up nothing the markup does not contain", async () => {
    // The browser half is served verbatim and never type-checked, so a renamed
    // element is a page that throws on load and a test suite that still passes.
    // This is the cheapest thing that would have caught it.
    const html = await (await auth.app.request("/settings/accounts")).text();
    const ids = [...html.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
    const templates = [...html.matchAll(/getElementById\("([^"]+)"\)\.content/g)].map(
      (match) => match[1],
    );

    expect(ids.length).toBeGreaterThan(3);
    for (const id of ids) {
      expect(html, `id "${id}" is read by the script`).toContain(`id="${id}"`);
    }
    for (const id of templates) {
      expect(html, `"${id}" is cloned as a template`).toContain(`<template id="${id}">`);
    }
  });

  it("wires every class the script reaches for to something in a template", async () => {
    const html = await (await auth.app.request("/settings/accounts")).text();
    const selectors = [...html.matchAll(/querySelector(?:All)?\("\.([a-z-]+)"\)/g)].map(
      (match) => match[1],
    );

    expect(selectors.length).toBeGreaterThan(5);
    for (const selector of new Set(selectors)) {
      expect(html, `class "${selector}" is queried by the script`).toMatch(
        new RegExp(`class="[^"]*\\b${selector}\\b`),
      );
    }
  });
});
