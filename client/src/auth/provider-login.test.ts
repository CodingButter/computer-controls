/**
 * The acceptance suite for signing in with your own model accounts.
 *
 * Two choices shape the whole file. The provider flows are mocked, because the
 * thing under test is our half — session ownership, credential keying, what
 * gets into a response body — and a suite that needed a real Anthropic consent
 * screen would run nowhere. The credential store is not mocked: it is the SDK's
 * real `AuthStorage` writing a real `auth.json` in a temporary directory, so
 * "the credential persisted" means the file on disk, in the format Mastra
 * Code's own gateway reads, and not a spy that agreed it was called.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import type { OAuthCredentials } from "@mastra/code-sdk/auth/types";

import { createProviderAuth, providerAuthApiRoutes, PROVIDER_IDS, type ProviderAuth } from "./index.ts";
import type { DeviceLoginPending } from "./login-sessions.ts";
import type { DevicePollResult, ProviderLoginFlows } from "./flows.ts";

/**
 * Sentinels, not realistic values. Every one of these is a string that must
 * never appear in anything the server says out loud, so they are written to be
 * unmistakable when the token-free scan goes looking.
 */
const SECRETS = {
  anthropicAccess: "SENTINEL-anthropic-access-token",
  anthropicRefresh: "SENTINEL-anthropic-refresh-token",
  anthropicVerifier: "SENTINEL-pkce-code-verifier",
  openaiAccess: "SENTINEL-openai-access-token",
  openaiRefresh: "SENTINEL-openai-refresh-token",
  pastedApiKey: "SENTINEL-pasted-api-key",
};

const ANTHROPIC_CREDENTIALS: OAuthCredentials = {
  access: SECRETS.anthropicAccess,
  refresh: SECRETS.anthropicRefresh,
  expires: 4_102_444_800_000,
};

const OPENAI_CREDENTIALS: OAuthCredentials = {
  access: SECRETS.openaiAccess,
  refresh: SECRETS.openaiRefresh,
  expires: 4_102_444_800_000,
};

const AUTHORIZATION_CODE = "auth-code-from-the-consent-page#state-abc";

/** A scripted stand-in for the SDK's two login flows. */
class MockLoginFlows implements ProviderLoginFlows {
  /** Codes the Anthropic exchange will accept. Anything else is rejected. */
  acceptedCode = AUTHORIZATION_CODE;
  /** Queued device-poll answers, consumed one per poll. */
  pollResults: DevicePollResult[] = [];
  completedWith?: { input: string; verifier: string };
  pollCount = 0;

  async startAnthropicLogin() {
    return {
      url: "https://claude.ai/oauth/authorize?client_id=test",
      verifier: SECRETS.anthropicVerifier,
    };
  }

  async completeAnthropicLogin(input: string, verifier: string) {
    this.completedWith = { input, verifier };
    if (verifier !== SECRETS.anthropicVerifier) throw new Error("PKCE verifier mismatch");
    if (input !== this.acceptedCode) throw new Error("Invalid authorization code");
    return ANTHROPIC_CREDENTIALS;
  }

  async startCodexDeviceLogin(): Promise<DeviceLoginPending> {
    return {
      deviceAuthId: "device-auth-1",
      userCode: "WXYZ-1234",
      url: "https://auth.openai.com/device",
      instructions: "Enter the code shown above.",
      intervalMs: 5_000,
      deadlineAt: Date.now() + 600_000,
    };
  }

  async pollCodexDeviceLogin(): Promise<DevicePollResult> {
    this.pollCount += 1;
    return this.pollResults.shift() ?? { status: "pending", nextPollMs: 5_000 };
  }
}

/**
 * One browser. Holds its own cookie jar, because the owner id lives in a cookie
 * and a caller that forgets it is, correctly, a different caller.
 */
class BrowserClient {
  private readonly auth: ProviderAuth;
  private cookie: string | undefined;
  /** Every response body this client has been given, for the token scan. */
  readonly seen: unknown[] = [];

  constructor(auth: ProviderAuth) {
    this.auth = auth;
  }

  async get(path: string): Promise<{ status: number; body: any }> {
    return this.send(path, { method: "GET" });
  }

  async post(path: string, payload: unknown): Promise<{ status: number; body: any }> {
    return this.send(path, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    });
  }

  private async send(path: string, init: RequestInit): Promise<{ status: number; body: any }> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    const response = await this.auth.app.request(path, { ...init, headers });

    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];

    const body: unknown = await response.json();
    this.seen.push(body);
    return { status: response.status, body };
  }
}

let authDir: string;
let authPath: string;
let storage: AuthStorage;
let flows: MockLoginFlows;
let auth: ProviderAuth;
let browser: BrowserClient;

beforeEach(() => {
  authDir = mkdtempSync(join(tmpdir(), "cc-auth-"));
  authPath = join(authDir, "auth.json");
  storage = new AuthStorage(authPath);
  flows = new MockLoginFlows();
  auth = createProviderAuth({ storage, flows });
  browser = new BrowserClient(auth);
});

afterEach(() => {
  rmSync(authDir, { recursive: true, force: true });
  delete process.env["ANTHROPIC_API_KEY"];
  delete process.env["OPENAI_API_KEY"];
});

/** What actually landed in `auth.json`, read back from disk. */
function credentialsOnDisk(): Record<string, { type: string; [key: string]: unknown }> {
  return JSON.parse(readFileSync(authPath, "utf-8"));
}

describe("the Anthropic paste-code flow", () => {
  it("test_anthropic_paste_code_flow_completes_against_a_mock", async () => {
    const started = await browser.post("/api/oauth/start", { provider: "anthropic" });

    expect(started.status).toBe(200);
    expect(started.body.status).toBe("pending");
    // The human needs somewhere to go. That is the entire outbound payload.
    expect(started.body.url).toBe("https://claude.ai/oauth/authorize?client_id=test");
    expect(started.body.sessionId).toEqual(expect.any(String));

    const completed = await browser.post("/api/oauth/complete", {
      sessionId: started.body.sessionId,
      code: AUTHORIZATION_CODE,
    });

    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("complete");

    // The verifier minted at `start` is the one used at `complete`, a request
    // later. That it survived without ever being sent to the browser is the
    // reason the session store exists.
    expect(flows.completedWith).toEqual({
      input: AUTHORIZATION_CODE,
      verifier: SECRETS.anthropicVerifier,
    });

    expect(credentialsOnDisk()["anthropic"]).toEqual({
      type: "oauth",
      ...ANTHROPIC_CREDENTIALS,
    });
  });

  it("reports a rejected code as a failed flow rather than a crash", async () => {
    const started = await browser.post("/api/oauth/start", { provider: "anthropic" });
    const completed = await browser.post("/api/oauth/complete", {
      sessionId: started.body.sessionId,
      code: "a-code-from-somewhere-else",
    });

    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("failed");
    expect(completed.body.error).toMatch(/Invalid authorization code/);
    expect(storage.has("anthropic")).toBe(false);
  });

  it("refuses to be polled, because that is the other provider's flow", async () => {
    const started = await browser.post("/api/oauth/start", { provider: "anthropic" });
    const polled = await browser.post("/api/oauth/poll", { sessionId: started.body.sessionId });

    expect(polled.status).toBe(400);
    expect(polled.body.error).toMatch(/pasting a code/);
  });
});

describe("the OpenAI device flow", () => {
  it("test_openai_device_flow_polls_to_completion_against_a_mock", async () => {
    const started = await browser.post("/api/oauth/start", { provider: "openai" });

    expect(started.status).toBe(200);
    expect(started.body.status).toBe("pending");
    expect(started.body.userCode).toBe("WXYZ-1234");
    expect(started.body.url).toBe("https://auth.openai.com/device");
    // The server sets the pace; the page does not invent one.
    expect(started.body.nextPollMs).toBe(5_000);

    flows.pollResults = [
      { status: "pending", nextPollMs: 7_000 },
      { status: "complete", credentials: OPENAI_CREDENTIALS },
    ];

    const stillWaiting = await browser.post("/api/oauth/poll", {
      sessionId: started.body.sessionId,
    });
    expect(stillWaiting.body.status).toBe("pending");
    expect(stillWaiting.body.nextPollMs).toBe(7_000);
    expect(storage.has("openai-codex")).toBe(false);

    const approved = await browser.post("/api/oauth/poll", { sessionId: started.body.sessionId });
    expect(approved.body.status).toBe("complete");

    // The name the person picked was "openai". The key it files under is not.
    const stored = credentialsOnDisk();
    expect(stored["openai-codex"]).toEqual({ type: "oauth", ...OPENAI_CREDENTIALS });
    expect(stored["openai"]).toBeUndefined();
  });

  it("stops polling once the flow has settled", async () => {
    const started = await browser.post("/api/oauth/start", { provider: "openai" });
    flows.pollResults = [{ status: "complete", credentials: OPENAI_CREDENTIALS }];

    await browser.post("/api/oauth/poll", { sessionId: started.body.sessionId });
    const pollsAfterCompletion = flows.pollCount;

    const again = await browser.post("/api/oauth/poll", { sessionId: started.body.sessionId });
    expect(again.body.status).toBe("complete");
    // A page that keeps polling does not keep asking OpenAI.
    expect(flows.pollCount).toBe(pollsAfterCompletion);
  });

  it("surfaces a denied authorization as a failure with a reason", async () => {
    const started = await browser.post("/api/oauth/start", { provider: "openai" });
    flows.pollResults = [{ status: "failed", error: "access_denied" }];

    const denied = await browser.post("/api/oauth/poll", { sessionId: started.body.sessionId });
    expect(denied.body.status).toBe("failed");
    expect(denied.body.error).toBe("access_denied");
    expect(storage.has("openai-codex")).toBe(false);
  });
});

describe("what the server says out loud", () => {
  it("test_no_response_ever_carries_a_token", async () => {
    // Drive both flows all the way through, plus every other route, so the scan
    // below has every response body this surface can produce — including the
    // completed ones, which are the only place a token could plausibly leak.
    const anthropic = await browser.post("/api/oauth/start", { provider: "anthropic" });
    await browser.post("/api/oauth/complete", {
      sessionId: anthropic.body.sessionId,
      code: AUTHORIZATION_CODE,
    });
    await browser.get(`/api/oauth/session/${anthropic.body.sessionId}`);

    const openai = await browser.post("/api/oauth/start", { provider: "openai" });
    flows.pollResults = [
      { status: "pending", nextPollMs: 1_000 },
      { status: "complete", credentials: OPENAI_CREDENTIALS },
    ];
    await browser.post("/api/oauth/poll", { sessionId: openai.body.sessionId });
    await browser.post("/api/oauth/poll", { sessionId: openai.body.sessionId });
    await browser.get(`/api/oauth/session/${openai.body.sessionId}`);

    await browser.post("/api/oauth/api-key", {
      provider: "anthropic",
      key: SECRETS.pastedApiKey,
    });
    await browser.get("/api/oauth/flows");
    await browser.post("/api/oauth/disconnect", { provider: "anthropic" });

    // Every body the client was handed, in one string.
    const everythingSaid = JSON.stringify(browser.seen);

    expect(browser.seen.length).toBe(10);
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(everythingSaid, `${name} escaped in a response body`).not.toContain(secret);
    }

    // And nothing shaped like a credential, in case a future field carries one
    // under a value this test did not think to script.
    expect(everythingSaid).not.toMatch(/"(access|refresh|verifier|key|token|deviceAuthId)"\s*:/);

    // Proof the flows really did complete — otherwise the assertions above are
    // satisfied by a surface that simply never worked.
    const stored = credentialsOnDisk();
    expect(stored["openai-codex"]).toEqual({ type: "oauth", ...OPENAI_CREDENTIALS });
  });

  it("does not relay a provider's error body, whatever the provider put in it", async () => {
    // The SDK builds some failure messages by interpolating the upstream
    // response — `Token exchange failed: ${await response.text()}` — so a
    // provider having a bad day decides what our error string contains. This is
    // that bad day.
    flows.completeAnthropicLogin = async () => {
      throw new Error(`Token exchange failed: {"access_token":"${SECRETS.anthropicAccess}"}`);
    };

    const started = await browser.post("/api/oauth/start", { provider: "anthropic" });
    const failed = await browser.post("/api/oauth/complete", {
      sessionId: started.body.sessionId,
      code: AUTHORIZATION_CODE,
    });

    expect(failed.body.status).toBe("failed");
    expect(JSON.stringify(failed.body)).not.toContain(SECRETS.anthropicAccess);
    expect(failed.body.error).toBe("Sign-in failed.");
  });

  it("still passes an ordinary failure through, so the human learns something", async () => {
    const started = await browser.post("/api/oauth/start", { provider: "anthropic" });
    const failed = await browser.post("/api/oauth/complete", {
      sessionId: started.body.sessionId,
      code: "not-the-code-you-were-given",
    });

    expect(failed.body.error).toBe("Invalid authorization code");
  });

  it("says nothing about a session it is refusing to talk about", async () => {
    const missing = await browser.get("/api/oauth/session/00000000-0000-0000-0000-000000000000");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "No such sign-in is in progress." });
  });
});

describe("who owns a flow", () => {
  it("test_a_flow_cannot_be_completed_by_a_different_session", async () => {
    const started = await browser.post("/api/oauth/start", { provider: "anthropic" });
    const sessionId: string = started.body.sessionId;

    // A second browser against the same server. It knows the session id — the
    // interesting case is the one where guessing it is not the obstacle.
    const stranger = new BrowserClient(auth);

    const stolenComplete = await stranger.post("/api/oauth/complete", {
      sessionId,
      code: AUTHORIZATION_CODE,
    });
    expect(stolenComplete.status).toBe(404);
    expect(stolenComplete.body.error).toBe("No such sign-in is in progress.");

    const stolenLookup = await stranger.get(`/api/oauth/session/${sessionId}`);
    // Not 403: a stranger learns nothing, not even that the flow is real.
    expect(stolenLookup.status).toBe(404);

    expect(flows.completedWith).toBeUndefined();
    expect(storage.has("anthropic")).toBe(false);

    // And the owner can still finish it, so the refusal above was about who was
    // asking rather than the flow being broken.
    const owned = await browser.post("/api/oauth/complete", {
      sessionId,
      code: AUTHORIZATION_CODE,
    });
    expect(owned.body.status).toBe("complete");
    expect(storage.isLoggedIn("anthropic")).toBe(true);
  });

  it("cannot be impersonated by a caller who simply asserts an owner", async () => {
    const started = await browser.post("/api/oauth/start", { provider: "anthropic" });
    const response = await auth.app.request("/api/oauth/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: started.body.sessionId,
        code: AUTHORIZATION_CODE,
        ownerId: "whoever-I-say-I-am",
      }),
    });
    // The owner is the cookie the server issued, not a field in the request.
    expect(response.status).toBe(404);
  });

  it("refuses a write another page sent here", async () => {
    // The attack this stops: a page the person happens to have open POSTs its
    // own API key to the hub on localhost, and from then on every agent request
    // is billed to, and visible to, whoever planted it. `disconnect` and
    // `api-key` name a provider rather than a flow, so the owner cookie cannot
    // be what protects them.
    const planted = await auth.app.request("/api/oauth/api-key", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://not-your-hub.test" },
      body: JSON.stringify({ provider: "openai", key: "attacker-key" }),
    });

    expect(planted.status).toBe(403);
    expect(storage.hasStoredApiKey("openai-codex")).toBe(false);
  });

  it("refuses a write dressed up to skip the browser's preflight", async () => {
    // A `text/plain` body is a "simple request": no preflight, so no CORS
    // check, so a silent cross-origin POST that lands. Demanding JSON is what
    // forces the preflight we deliberately do not answer.
    const smuggled = await auth.app.request("/api/oauth/disconnect", {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ provider: "anthropic" }),
    });

    expect(smuggled.status).toBe(415);
  });

  it("hands the owner cookie out in a form the page cannot read", async () => {
    const response = await auth.app.request("/api/oauth/flows");
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(cookie).toContain("cc_login_owner=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });
});

describe("the fallback path for a pasted key", () => {
  it("files an OpenAI key where model resolution looks for it", async () => {
    const saved = await browser.post("/api/oauth/api-key", {
      provider: "openai",
      key: SECRETS.pastedApiKey,
    });

    expect(saved.body).toEqual({
      provider: "openai",
      name: "OpenAI",
      connected: true,
      method: "api-key",
      loginKind: "device-code",
      docUrl: "https://platform.openai.com/docs/models",
    });
    // Same auth provider id as the OAuth path, same store, one lookup.
    expect(storage.getStoredApiKey("openai-codex")).toBe(SECRETS.pastedApiKey);
    expect(process.env["OPENAI_API_KEY"]).toBe(SECRETS.pastedApiKey);
  });

  it("refuses an empty key rather than storing a connection that is not one", async () => {
    const refused = await browser.post("/api/oauth/api-key", { provider: "anthropic", key: "   " });
    expect(refused.status).toBe(400);
    expect(storage.hasStoredApiKey("anthropic")).toBe(false);
  });
});

describe("disconnecting", () => {
  it("clears both slots, so a disconnected provider stays disconnected", async () => {
    const started = await browser.post("/api/oauth/start", { provider: "anthropic" });
    await browser.post("/api/oauth/complete", {
      sessionId: started.body.sessionId,
      code: AUTHORIZATION_CODE,
    });
    await browser.post("/api/oauth/api-key", { provider: "anthropic", key: SECRETS.pastedApiKey });

    const disconnected = await browser.post("/api/oauth/disconnect", { provider: "anthropic" });

    expect(disconnected.body.connected).toBe(false);
    // The OAuth slot and the pasted-key slot are different keys in the same
    // file. Clearing one and leaving the other is a provider that keeps working
    // after the person asked it to stop.
    expect(storage.has("anthropic")).toBe(false);
    expect(storage.hasStoredApiKey("anthropic")).toBe(false);
    expect(process.env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("leaves an environment the operator set themselves alone", async () => {
    // Disconnecting is about the credential this hub was given, not about the
    // shell that started it. Emptying an operator's exported key because a user
    // clicked disconnect in a browser is a worse surprise than the leftover it
    // was trying to prevent.
    process.env["OPENAI_API_KEY"] = "operator-exported-this-before-we-started";

    await browser.post("/api/oauth/disconnect", { provider: "openai" });

    expect(process.env["OPENAI_API_KEY"]).toBe("operator-exported-this-before-we-started");
  });
});

describe("what the settings page is told", () => {
  it("lists every provider, how each signs in, and whether it is connected", async () => {
    const before = await browser.get("/api/oauth/flows");
    const leading = before.body.providers
      .slice(0, 3)
      .map(({ provider, name, connected, loginKind }: Record<string, unknown>) => ({
        provider,
        name,
        connected,
        loginKind,
      }));

    // The two the product owns a login flow for lead the list, then Google:
    // the orb's credential, which arrives by paste because there is no SDK flow
    // to drive, and the settings page renders a key field rather than a sign-in
    // button because of this value. Everything after them is the rest of the
    // runtime's registry, which `provider-catalogue.test.ts` covers.
    expect(leading).toEqual([
      { provider: "anthropic", name: "Anthropic", connected: false, loginKind: "paste-code" },
      { provider: "openai", name: "OpenAI", connected: false, loginKind: "device-code" },
      { provider: "google", name: "Google", connected: false, loginKind: "api-key" },
    ]);

    const started = await browser.post("/api/oauth/start", { provider: "anthropic" });
    await browser.post("/api/oauth/complete", {
      sessionId: started.body.sessionId,
      code: AUTHORIZATION_CODE,
    });

    const after = await browser.get("/api/oauth/flows");
    expect(after.body.providers[0]).toEqual({
      provider: "anthropic",
      name: "Anthropic",
      connected: true,
      method: "oauth",
      loginKind: "paste-code",
      docUrl: "https://docs.anthropic.com/en/docs/about-claude/models",
      expiresAt: ANTHROPIC_CREDENTIALS.expires,
    });
  });

  it("serves a settings section with a control for each provider", async () => {
    const response = await auth.app.request("/settings/accounts");
    expect(response.status).toBe(200);

    const page = await response.text();
    expect(page).toContain("Model accounts");
    expect(page).toContain("provider-template");
    expect(page).toContain("/api/oauth");
    // The page drives the flows; it never names a credential field, because
    // there is no credential field in anything it is given.
    expect(page).not.toMatch(/access_?[Tt]oken|refresh_?[Tt]oken|verifier|apiKey/);
  });

  it("turns an unknown provider away", async () => {
    const refused = await browser.post("/api/oauth/start", { provider: "some-other-model-shop" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("Unknown provider.");
  });
});

describe("mounting into a Mastra server", () => {
  it("actually serves through the descriptors, rather than merely listing them", async () => {
    // The descriptors forward the raw request to the same app the rest of this
    // suite drives. Listing the right paths would prove nothing if the
    // forwarding did not work, which is the half a client mounting these would
    // discover the hard way.
    const flowsRoute = providerAuthApiRoutes(auth).find(
      (route) => route.path === "/api/oauth/flows",
    );

    expect(flowsRoute).toBeDefined();
    const handler = (flowsRoute as { handler?: unknown }).handler as (c: {
      req: { raw: Request };
    }) => Promise<Response>;
    expect(handler).toBeTypeOf("function");

    const response = await handler({
      req: { raw: new Request("http://localhost/api/oauth/flows") },
    });
    const body = (await response.json()) as { providers: unknown[] };

    expect(response.status).toBe(200);
    expect(body.providers).toHaveLength(PROVIDER_IDS.length);
  });

  it("offers the whole surface as route descriptors", () => {
    const routes = providerAuthApiRoutes(auth).map((route) => `${route.method} ${route.path}`);

    expect(routes).toEqual([
      "GET /api/oauth/flows",
      "POST /api/oauth/start",
      "POST /api/oauth/complete",
      "POST /api/oauth/poll",
      "GET /api/oauth/session/:id",
      "POST /api/oauth/api-key",
      "POST /api/oauth/disconnect",
      "GET /settings/accounts",
    ]);
  });
});
