import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

import { ModelsPanel } from "@/components/models/models";
import {
  completeLogin,
  createModelPack,
  deleteModelPack,
  parseFlows,
  parseModelPacks,
  parseVoiceProviders,
  putActivePack,
  saveApiKey,
  startLogin,
  parseRealtimeSettings,
  putRealtimeSettings,
  type ModelPacksView,
  type ProviderFlow,
  type RealtimeSettings,
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

/** A copy of a live GET /api/orb/realtime-settings, trimmed to two of each. */
const REALTIME: RealtimeSettings = {
  model: "gemini-3.1-flash-live-preview",
  voice: "Aoede",
  models: [
    { name: "gemini-3.1-flash-live-preview", source: "curated" },
    { name: "gemini-3.1-pro-live-preview", source: "curated" },
  ],
  voices: [
    { name: "Aoede", source: "curated" },
    { name: "Puck", source: "curated" },
  ],
  warnings: [],
};

const PACKS: ModelPacksView = {
  active: {
    id: "computer-controls-anthropic",
    name: "computer-controls-anthropic",
    models: { minimal: "anthropic/claude-haiku-4-5", standard: "anthropic/claude-sonnet-4-6", heavy: "anthropic/claude-opus-4-6" },
    thinking: "anthropic/claude-sonnet-4-6",
  },
  thinkingTier: "standard",
  tiers: ["minimal", "standard", "heavy"],
  overrides: {},
  packs: [
    {
      id: "computer-controls-anthropic",
      name: "computer-controls-anthropic",
      source: "built-in",
      models: { minimal: "anthropic/claude-haiku-4-5", standard: "anthropic/claude-sonnet-4-6", heavy: "anthropic/claude-opus-4-6" },
      active: true,
      selectable: true,
    },
    {
      id: "custom:cheap-day",
      name: "Cheap day",
      source: "custom",
      models: { minimal: "google/gemini-3.5-flash", standard: "google/gemini-3.5-flash", heavy: "google/gemini-3-pro" },
      active: false,
      selectable: false,
      reason: "Google has no key on this machine, so this pack cannot answer a turn.",
    },
  ],
  providers: [
    { provider: "anthropic", name: "Anthropic", connected: true, models: ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"] },
    { provider: "google", name: "Google", connected: false, models: ["google/gemini-3.5-flash"] },
  ],
};

const noop = () => {};

function panel(overrides: Partial<Parameters<typeof ModelsPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <ModelsPanel
      providers={PROVIDERS}
      voices={VOICES}
      packs={PACKS}
      onConnect={noop}
      onDisconnect={noop}
      onSaveKey={noop}
      onSubmitCode={noop}
      onCancelFlow={noop}
      onChooseRealtimeModel={noop}
      onChooseRealtimeVoice={noop}
      onSelectPack={noop}
      onCreatePack={noop}
      onDeletePack={noop}
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
  // The providers wear their own marks, drawn offline — no logo service, no
  // third party learning which accounts this machine holds.
  expect(html).not.toContain('src="http');
  expect((html.match(/<svg/g) ?? []).length).toBeGreaterThanOrEqual(3);
});

test("every pack is listed with its tiers, and the active one is marked", () => {
  const html = panel();
  expect(html).toContain("Model packs");
  expect(html).toContain("computer-controls-anthropic");
  expect(html).toContain("anthropic/claude-opus-4-6");
  expect(html).toContain("Cheap day");
  expect(html).toContain("active");
  // The tier a browser turn actually runs at is named, so the page says which
  // row answers a person rather than leaving three equal-looking models.
  expect(html).toContain("thinks");
  expect(html).toContain("anthropic/claude-sonnet-4-6");
});

test("a pack that cannot be picked keeps its button off and says why", () => {
  const html = panel();
  // The unusable pack is offered as a fact with a reason, never as a control
  // that would fail at the next turn instead of here.
  expect(html).toContain("Google has no key on this machine");
  expect((html.match(/<button[^>]*disabled/g) ?? []).length).toBeGreaterThanOrEqual(1);
  // The active pack offers no "use" button — there is nothing to change.
  expect((html.match(/Use this pack/g) ?? []).length).toBe(1);
});

test("built-ins cannot be deleted, but can be duplicated into a starting point", () => {
  const html = panel();
  expect((html.match(/Delete/g) ?? []).length).toBe(1);
  expect((html.match(/Duplicate/g) ?? []).length).toBe(2);
});

test("the maker offers every tier, and marks providers this machine has no key for", () => {
  const html = panel();
  expect(html).toContain('aria-label="Pack name"');
  expect(html).toContain('aria-label="minimal model"');
  expect(html).toContain('aria-label="standard model"');
  expect(html).toContain('aria-label="heavy model"');
  expect(html).toContain("Google — no key on this machine");
  // No key, no offer: the models are visible in every tier's list, and not
  // selectable in any of them.
  expect((html.match(/<optgroup[^>]*disabled=""/g) ?? []).length).toBe(PACKS.tiers.length);
});

test("an environment override is named, because no pack choice can move that tier", () => {
  const html = panel({ packs: { ...PACKS, overrides: { heavy: "COMCON_MODEL_HEAVY" } } });
  expect(html).toContain("COMCON_MODEL_HEAVY");
});

test("a hub that refuses a pack change says so verbatim, and keeps the list on screen", () => {
  const html = panel({ packRefusal: "computer-controls-anthropic is declared by this build." });
  expect(html).toContain("computer-controls-anthropic is declared by this build.");
  expect(html).toContain("Cheap day");
  // Still asking is a sentence, not an empty card.
  expect(panel({ packs: null })).toContain("Asking the hub…");
});

test("the realtime model and voice are pickers over what the hub offers, with what it holds selected", () => {
  const html = panel({ realtime: REALTIME });
  expect(html).toContain('aria-label="Model"');
  expect(html).toContain('aria-label="Voice"');
  expect(html).toContain("gemini-3.1-pro-live-preview");
  expect(html).toContain("Aoede");
  // The saved values are the selected ones, not merely present in the list.
  expect(html).toMatch(/<option value="gemini-3.1-flash-live-preview" selected/);
  expect(html).toMatch(/<option value="Aoede" selected/);
  // Nothing chosen is its own state, and it is not the same as choosing the
  // first entry: the orb then runs on what this build pins.
  const untouched = panel({ realtime: { ...REALTIME, model: undefined, voice: undefined } });
  expect(untouched).toContain("This build&#x27;s default");
  expect(untouched).not.toMatch(/<option value="Aoede" selected/);
});

test("a saved value the hub's catalog does not name is still offered, still selected, still warned about", () => {
  const html = panel({
    realtime: {
      ...REALTIME,
      voice: "Bellwether",
      warnings: ['"Bellwether" is not in the known voice list. It has been saved.'],
    },
  });
  // Dropping it would show a person a setting other than the one running,
  // which is the bug this picker exists downstream of.
  expect(html).toContain("Bellwether (not in this list)");
  expect(html).toMatch(/<option value="Bellwether" selected/);
  expect(html).toContain("is not in the known voice list");
});

test("the provider lane stays inert and says why, while the pickers beside it do not", () => {
  const html = panel({
    realtime: REALTIME,
    voices: [{ provider: "gemini-live", name: "Gemini Live", lane: "realtime", usable: false, reason: "no key" }],
  });
  // Exactly one disabled control: the provider, which nothing accepts a choice
  // for yet. The model and voice are live.
  // Counted on the attribute, not the class list: every select carries a
  // `disabled:` style rule whether or not it is disabled.
  expect((html.match(/<select[^>]*\sdisabled=""/g) ?? []).length).toBe(1);
  expect(html).toContain("no key");
});

test("an unreachable settings route hides the pickers and shows the reason, rather than offering empty ones", () => {
  const html = panel({ realtimeError: "/api/orb/realtime-settings answered 503" });
  expect(html).toContain("/api/orb/realtime-settings answered 503");
  // An empty picker reads as "nothing to choose"; the truth is nobody was asked.
  expect(html).not.toContain('aria-label="Model"');
});

test("a refused save is shown beside the pickers, which keep the values the hub still holds", () => {
  const html = panel({ realtime: REALTIME, realtimeError: "The hub refused the change." });
  expect(html).toContain("The hub refused the change.");
  expect(html).toMatch(/<option value="Aoede" selected/);
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

test("choosing a model PUTs only that field, and the hub's answer is what the page keeps", async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: "gemini-3.1-pro-live-preview", models: [], voices: [], warnings: [] }),
      };
    }),
  );

  const saved = await putRealtimeSettings({ model: "gemini-3.1-pro-live-preview" });
  // One field, so the other is left alone rather than cleared by omission-as-empty.
  expect(calls[0]?.[0]).toBe("/api/orb/realtime-settings");
  expect(calls[0]?.[1]).toMatchObject({
    method: "PUT",
    body: JSON.stringify({ model: "gemini-3.1-pro-live-preview" }),
  });
  // What the file holds, not what was picked.
  expect(saved.model).toBe("gemini-3.1-pro-live-preview");
  expect(saved.voice).toBeUndefined();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "model must be a string." }) })),
  );
  await expect(putRealtimeSettings({ model: "" })).rejects.toThrow("model must be a string.");
});

test("a settings answer is read by name, and an answer that is not one is refused", () => {
  const parsed = parseRealtimeSettings({
    model: "gemini-3.1-flash-live-preview",
    models: [{ name: "gemini-3.1-flash-live-preview", source: "curated" }, { junk: true }],
    voices: [{ name: "Aoede", source: "curated" }],
    warnings: ["a warning", 7],
  });
  expect(parsed.models).toHaveLength(1);
  expect(parsed.warnings).toEqual(["a warning"]);
  // Absent is absent: no empty string standing in for a choice nobody made.
  expect(parsed.voice).toBeUndefined();
  expect(() => parseRealtimeSettings({ nope: true })).toThrow();
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

test("the pack calls address the hub's own routes with the change in the body", async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return { ok: true, status: 200, json: async () => ({ packs: [] }) };
    }),
  );

  await putActivePack("custom:cheap-day");
  await createModelPack("Cheap day", { minimal: "google/gemini-3.5-flash" });
  await deleteModelPack("custom:cheap day");

  expect(calls.map(([url]) => url)).toEqual([
    "/api/model-packs/active",
    "/api/model-packs",
    // The id is a path segment, so it is encoded rather than pasted in.
    "/api/model-packs/custom%3Acheap%20day",
  ]);
  expect(calls[0]?.[1]).toMatchObject({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "custom:cheap-day" }),
  });
  expect(calls[1]?.[1]).toMatchObject({ method: "POST" });
  expect(calls[2]?.[1]).toMatchObject({ method: "DELETE" });
});

test("a refused pack change is a reason, an unreachable hub is not", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: "A pack named Cheap day already exists." }),
    })),
  );
  expect(await createModelPack("Cheap day", {})).toEqual({
    kind: "refused",
    detail: "A pack named Cheap day already exists.",
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("connection refused");
    }),
  );
  expect(await putActivePack("x")).toEqual({ kind: "unreachable", detail: "connection refused" });
});

test("a pack answer keeps only named fields, and an unrecognisable one is refused", () => {
  const view = parseModelPacks({
    active: { id: "a", name: "A", models: { standard: "anthropic/claude-sonnet-4-6" }, thinking: "anthropic/claude-sonnet-4-6" },
    thinkingTier: "standard",
    tiers: ["standard"],
    overrides: {},
    packs: [
      { id: "a", name: "A", source: "built-in", models: { standard: "m" }, active: true, selectable: true, apiKey: "sk-leaked" },
      { junk: true },
    ],
    providers: [{ provider: "anthropic", name: "Anthropic", connected: true, models: ["m"], apiKey: "sk-leaked" }],
  });
  expect(view.packs).toHaveLength(1);
  expect(JSON.stringify(view)).not.toContain("leaked");
  expect(() => parseModelPacks({ nope: true })).toThrow("not a model-packs response");
});
