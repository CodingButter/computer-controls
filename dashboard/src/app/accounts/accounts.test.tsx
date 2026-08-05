import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

import { AccountsPanel } from "@/components/accounts/accounts";
import {
  completeLogin,
  parseFlows,
  parseVoiceProviders,
  saveApiKey,
  startLogin,
  type ProviderFlow,
  type VoiceProvider,
} from "@/lib/hub";

const PROVIDERS: readonly ProviderFlow[] = [
  { provider: "anthropic", name: "Anthropic", connected: true, method: "oauth", loginKind: "paste-code" },
  { provider: "openai", name: "OpenAI", connected: false, loginKind: "device-code" },
  { provider: "google", name: "Google", connected: true, method: "api-key", loginKind: "api-key" },
];

const VOICES: readonly VoiceProvider[] = [
  { provider: "gemini-live", name: "Gemini Live", lane: "realtime", usable: true },
  { provider: "openai", name: "OpenAI", lane: "http", usable: false, reason: "no credential" },
];

const noop = () => {};

function panel(overrides: Partial<Parameters<typeof AccountsPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <AccountsPanel
      providers={PROVIDERS}
      voices={VOICES}
      onConnect={noop}
      onDisconnect={noop}
      onSaveKey={noop}
      onSubmitCode={noop}
      onCancelFlow={noop}
      {...overrides}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("providers render with their connection state and the affordance each one has", () => {
  const html = panel();
  expect(html).toContain("Model Providers");
  expect(html).toContain("Anthropic");
  expect(html).toContain("Connected with an API key");
  expect(html).toContain("Not connected");
  // A provider with a sign-in flow offers Connect; every unconnected one can
  // still take a pasted key.
  expect(html).toContain("Connect");
  expect(html).toContain('aria-label="OpenAI API key"');
  expect(html).toContain("Disconnect");
});

test("voice lanes render what the hub offers, and say why a provider cannot serve", () => {
  const html = panel();
  expect(html).toContain("Realtime voice");
  expect(html).toContain("Speech synthesis");
  expect(html).toContain("Gemini Live");
  expect(html).toContain("no credential");
  // No credentials at all is a sentence, not an empty box.
  expect(panel({ voices: [] })).toContain("Connect an account above to give the agent a voice");
});

test("a device-code flow shows the code and waits; a paste-code flow asks for the code", () => {
  const device = panel({
    flow: {
      sessionId: "s1",
      provider: "openai",
      status: "pending",
      url: "https://example.test/device",
      userCode: "ABCD-1234",
      nextPollMs: 2000,
    },
  });
  expect(device).toContain("ABCD-1234");
  expect(device).toContain("Waiting for authorization…");

  const paste = panel({
    flow: { sessionId: "s2", provider: "anthropic", status: "pending", url: "https://example.test/auth" },
    error: "that code did not work",
  });
  expect(paste).toContain('aria-label="Authorization code"');
  expect(paste).toContain("Finish");
  expect(paste).toContain("that code did not work");
});

test("the sign-in calls post to the hub's own routes and surface refusals verbatim", async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return {
        ok: true,
        status: 200,
        json: async () => ({ sessionId: "s1", provider: "openai", status: "pending", nextPollMs: 5000 }),
      };
    }),
  );

  const started = await startLogin("openai");
  expect(started).toEqual({ sessionId: "s1", provider: "openai", status: "pending", nextPollMs: 5000 });
  await completeLogin("s1", "code-123");
  await saveApiKey("google", "sk-test");

  expect(calls.map(([url]) => url)).toEqual([
    "/api/oauth/start",
    "/api/oauth/complete",
    "/api/oauth/api-key",
  ]);
  expect(calls[0]?.[1]).toMatchObject({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "openai" }),
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "Unknown provider." }) })),
  );
  await expect(startLogin("nope")).rejects.toThrow("Unknown provider.");
});

test("nothing token-shaped survives parsing: the page only ever sees named fields", () => {
  const parsed = parseFlows({
    providers: [
      {
        provider: "anthropic",
        name: "Anthropic",
        connected: true,
        method: "oauth",
        loginKind: "paste-code",
        // A hub that started leaking would leak past this line, not through it.
        accessToken: "sk-leaked",
        refreshToken: "rt-leaked",
        apiKey: "key-leaked",
      },
      { junk: true },
    ],
  });
  expect(parsed).toHaveLength(1);
  expect(Object.keys(parsed[0] ?? {}).sort()).toEqual([
    "connected",
    "loginKind",
    "method",
    "name",
    "provider",
  ]);
  expect(JSON.stringify(parsed)).not.toContain("leaked");

  const voices = parseVoiceProviders({
    providers: [{ provider: "openai", name: "OpenAI", lane: "http", usable: true, key: "sk-leaked" }],
  });
  expect(JSON.stringify(voices)).not.toContain("leaked");
  expect(() => parseFlows({ nope: true })).toThrow();
});
