import { describe, expect, it, vi } from "vitest";
import type { AuthCredential } from "@mastra/code-sdk/auth/types";
import { CompositeVoice } from "@mastra/core/voice";

import { isRefusal, resolveVoiceProvider } from "./credentials.ts";
import {
  VOICE_PROVIDERS,
  VOICE_PROVIDER_IDS,
  listVoiceProviders,
  parseVoiceProviderId,
  type VoiceProviderId,
} from "./providers.ts";
import { buildableVoiceProviders, createSessionVoice } from "./session-voice.ts";
import { buildVoiceApp, VOICE_PROVIDERS_PATH } from "./routes.ts";

/**
 * The same store shape the rest of the voice tests use: credentials as they sit
 * on disk, and a refresh that answers from them rather than from a network.
 */
function storeHolding(
  credentials: Record<string, AuthCredential>,
  apiKeys: Record<string, string> = {},
) {
  return {
    get: (provider: string) => credentials[provider],
    getStoredApiKey: (provider: string) => apiKeys[provider],
    getApiKey: vi.fn(async (provider: string) => {
      const credential = credentials[provider];
      if (!credential) return undefined;
      return credential.type === "api_key" ? credential.key : credential.access;
    }),
  };
}

const OPENAI_SLOT = VOICE_PROVIDERS.openai.authProviderId;
const GEMINI_SLOT = VOICE_PROVIDERS["gemini-live"].authProviderId;

describe("the settings surface offers only providers with credentials", () => {
  it("offers nothing on a machine with no voice accounts", async () => {
    const app = buildVoiceApp({ providers: () => listVoiceProviders(storeHolding({})) });

    const body = await (await app.request(VOICE_PROVIDERS_PATH)).json();

    expect(body).toEqual({ providers: [] });
  });

  it("test_the_settings_surface_offers_only_providers_with_credentials", () => {
    const offered = listVoiceProviders(storeHolding({}, { [OPENAI_SLOT]: "sk-pasted" }));

    // Gemini is a provider this hub knows and cannot offer: no key, no offer.
    expect(offered.map((entry) => entry.provider)).toEqual(["openai"]);
  });

  it("offers a second account the moment its key is present, with no restart", async () => {
    // The route asks the store per request rather than reading a list captured
    // at boot, which is the whole reason connecting an account in the section
    // above can change the section below.
    const apiKeys: Record<string, string> = { [OPENAI_SLOT]: "sk-pasted" };
    const app = buildVoiceApp({
      providers: () => listVoiceProviders(storeHolding({}, apiKeys)),
    });

    const before = await (await app.request(VOICE_PROVIDERS_PATH)).json();
    apiKeys[GEMINI_SLOT] = "google-key";
    const after = await (await app.request(VOICE_PROVIDERS_PATH)).json();

    expect(before.providers.map((entry: { provider: string }) => entry.provider)).toEqual([
      "openai",
    ]);
    expect(after.providers.map((entry: { provider: string }) => entry.provider)).toEqual([
      "openai",
      "gemini-live",
    ]);
  });

  it("counts an OAuth login as a credential, not just a pasted key", () => {
    const offered = listVoiceProviders(
      storeHolding({
        [OPENAI_SLOT]: {
          type: "oauth",
          access: "token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        } as AuthCredential,
      }),
    );

    expect(offered.map((entry) => entry.provider)).toEqual(["openai"]);
  });

  it("says why a connected account still cannot speak, rather than hiding it", () => {
    const [offered] = listVoiceProviders(storeHolding({}, { [GEMINI_SLOT]: "google-key" }));

    expect(offered.usable).toBe(false);
    expect(offered.reason).toMatch(/live connection/i);
  });

  it("never puts a credential in what the surface is told", async () => {
    const app = buildVoiceApp({
      providers: () =>
        listVoiceProviders(
          storeHolding({}, { [OPENAI_SLOT]: "sk-pasted", [GEMINI_SLOT]: "google-key" }),
        ),
    });

    const body = await (await app.request(VOICE_PROVIDERS_PATH)).text();

    expect(body).not.toContain("sk-pasted");
    expect(body).not.toContain("google-key");
  });
});

describe("switching the voice provider requires no code change", () => {
  it("test_switching_the_voice_provider_requires_no_code_change", async () => {
    const store = storeHolding(
      {},
      { [OPENAI_SLOT]: "sk-pasted", [GEMINI_SLOT]: "google-key" },
    );

    const chosenOpenai = await resolveVoiceProvider(store, "openai");
    const chosenGemini = await resolveVoiceProvider(store, "gemini-live");

    expect(chosenOpenai).toEqual({ kind: "api-key", key: "sk-pasted", provider: "openai" });
    // Same store, same code, different mouth — the only thing that moved is the
    // setting. Gemini's refusal is about its lane, not its credential.
    expect(isRefusal(chosenGemini)).toBe(true);
  });

  it("uses the connected account when nobody has chosen one", async () => {
    const resolved = await resolveVoiceProvider(
      storeHolding({}, { [OPENAI_SLOT]: "sk-pasted" }),
    );

    expect(resolved).toEqual({ kind: "api-key", key: "sk-pasted", provider: "openai" });
  });

  it("refuses by name rather than falling back to a mouth nobody picked", async () => {
    const resolved = await resolveVoiceProvider(
      storeHolding({}, { [OPENAI_SLOT]: "sk-pasted" }),
      "gemini-live",
    );

    // Falling through to OpenAI here would hand back a working voice that is
    // not the one that was asked for, and no way to notice.
    expect(isRefusal(resolved)).toBe(true);
    expect(resolved).toMatchObject({ reason: expect.stringMatching(/Google/) });
  });

  it("names the missing account in the refusal for whichever one was chosen", async () => {
    for (const provider of VOICE_PROVIDER_IDS) {
      const resolved = await resolveVoiceProvider(storeHolding({}), provider);

      expect(isRefusal(resolved)).toBe(true);
      expect((resolved as { reason: string }).reason).toContain(
        VOICE_PROVIDERS[provider].name === "Gemini Live" ? "Google" : "OpenAI",
      );
    }
  });

  it("reads a provider name from a setting and rejects anything else", () => {
    expect(parseVoiceProviderId("gemini-live")).toBe("gemini-live");
    expect(parseVoiceProviderId("openai")).toBe("openai");
    // A stale or mistyped setting must not become a provider id by accident.
    expect(parseVoiceProviderId("openai-realtime")).toBeUndefined();
    expect(parseVoiceProviderId(undefined)).toBeUndefined();
    expect(parseVoiceProviderId(7)).toBeUndefined();
  });

  it("has a descriptor for every provider it can build, and no orphans", () => {
    for (const provider of buildableVoiceProviders()) {
      expect(VOICE_PROVIDERS[provider]).toBeDefined();
      expect(VOICE_PROVIDERS[provider].lane).toBe("http");
    }
    for (const provider of VOICE_PROVIDER_IDS) {
      expect(VOICE_PROVIDERS[provider].id).toBe(provider);
      expect(VOICE_PROVIDERS[provider].authProviderId).toBeTruthy();
    }
  });
});

/**
 * The toolbox keeps hand-shaped tools out of the session, but the voice is a
 * second door to the same room, and it is not a hypothetical one: when an agent
 * resolves its voice, core calls `voice.addTools(wrappedTools)` with the whole
 * toolset it just built. A provider that accepted them would be able to call
 * them over its own socket — a path that never passes the daemon's consent
 * ceiling and never reaches the audit log.
 *
 * `CompositeVoice.addTools` forwards to its realtime provider and returns early
 * when there isn't one. So the invariant that holds the ceiling is not "we do
 * not call addTools" — core does, on our behalf — it is that nothing this lane
 * builds has a realtime provider to forward them to.
 */
describe("no configured provider holds desktop or memory tools", () => {
  const DESKTOP_TOOL = {
    move_mouse: { description: "move the pointer", execute: async () => undefined },
  };

  it("test_no_configured_provider_holds_desktop_or_memory_tools", () => {
    for (const provider of buildableVoiceProviders()) {
      const voice = createSessionVoice({ kind: "api-key", key: "sk-test", provider });
      expect(voice).toBeDefined();

      // Exactly what core does when the agent resolves its voice.
      voice!.addTools(DESKTOP_TOOL);

      expect(realtimeProviderOf(voice)).toBeUndefined();
    }
  });

  it("proves that door is real: a realtime provider would have taken them", () => {
    // Without this, the assertion above passes for the wrong reason — a version
    // that renamed or removed the seam would look identical to one that closed
    // it. This drives the same call into a composite that does have a realtime
    // provider and shows the tools land.
    const realtime = { addTools: vi.fn(), addInstructions: vi.fn() };
    const composite = new CompositeVoice({ realtime: realtime as never });

    composite.addTools(DESKTOP_TOOL);

    expect(realtime.addTools).toHaveBeenCalledWith(DESKTOP_TOOL);
  });

  it("refuses to build a realtime provider from this lane at all", () => {
    // Not "builds one without tools" — builds nothing. A realtime socket is the
    // shape that can carry a tool call, so the lane that cannot supervise one
    // does not open it. When the orb lands it becomes the supervisor.
    for (const provider of VOICE_PROVIDER_IDS) {
      if (VOICE_PROVIDERS[provider].lane === "http") continue;

      expect(
        createSessionVoice({ kind: "api-key", key: "google-key", provider }),
      ).toBeUndefined();
    }
  });

  it("gives a chosen realtime provider a reason instead of a silent nothing", async () => {
    const resolved = await resolveVoiceProvider(
      storeHolding({}, { [GEMINI_SLOT]: "google-key" }),
      "gemini-live",
    );

    expect(isRefusal(resolved)).toBe(true);
    expect(createSessionVoice(resolved)).toBeUndefined();
  });
});

function realtimeProviderOf(voice: unknown): unknown {
  return (voice as { realtimeProvider?: unknown }).realtimeProvider;
}

/** Guards the loop above: a provider list that emptied would pass vacuously. */
describe("the provider registry is not empty", () => {
  it("knows at least one buildable mouth and one realtime mouth", () => {
    expect(buildableVoiceProviders().length).toBeGreaterThan(0);
    expect(
      VOICE_PROVIDER_IDS.filter(
        (provider: VoiceProviderId) => VOICE_PROVIDERS[provider].lane === "realtime",
      ).length,
    ).toBeGreaterThan(0);
  });
});
