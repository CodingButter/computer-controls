import { describe, expect, it, vi } from "vitest";
import type { AuthCredential } from "@mastra/code-sdk/auth/types";

import { isRefusal, resolveRealtimeProvider } from "./credentials.ts";
import {
  REALTIME_PROVIDERS,
  REALTIME_PROVIDER_IDS,
  DEFAULT_REALTIME_PROVIDER,
  hasRealtimeCredential,
  parseRealtimeProviderId,
} from "./providers.ts";

/**
 * The same store shape the orb and voice tests use: credentials as they sit on
 * disk, and a refresh that answers from them rather than from a network.
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

const GEMINI_SLOT = REALTIME_PROVIDERS["gemini-live"].authProviderId;
const OPENAI_SLOT = REALTIME_PROVIDERS.openai.authProviderId;

describe("the realtime provider registry", () => {
  it("knows two providers, filed under the names the gateway expects", () => {
    expect(REALTIME_PROVIDER_IDS).toEqual(["gemini-live", "openai"]);
    expect(REALTIME_PROVIDERS["gemini-live"].authProviderId).toBe("google");
    expect(REALTIME_PROVIDERS.openai.authProviderId).toBe("openai-codex");
  });

  it("defaults to Gemini Live, the provider the orb shipped with", () => {
    expect(DEFAULT_REALTIME_PROVIDER).toBe("gemini-live");
  });

  it("reads a provider name from a setting and rejects anything else", () => {
    expect(parseRealtimeProviderId("gemini-live")).toBe("gemini-live");
    expect(parseRealtimeProviderId("openai")).toBe("openai");
    // A stale or mistyped setting must not become a provider id by accident.
    expect(parseRealtimeProviderId("openai-realtime")).toBeUndefined();
    expect(parseRealtimeProviderId(undefined)).toBeUndefined();
    expect(parseRealtimeProviderId(7)).toBeUndefined();
  });

  it("counts a stored key, an auth.json key, or an OAuth login as a credential", () => {
    const byKey = hasRealtimeCredential(storeHolding({}, { [OPENAI_SLOT]: "sk-pasted" }), "openai");
    const byAuthJson = hasRealtimeCredential(
      storeHolding({ [GEMINI_SLOT]: { type: "api_key", key: "goog" } }),
      "gemini-live",
    );
    const byOauth = hasRealtimeCredential(
      storeHolding({
        [OPENAI_SLOT]: { type: "oauth", access: "t", refresh: "r", expires: 1 } as AuthCredential,
      }),
      "openai",
    );

    expect(byKey).toBe(true);
    expect(byAuthJson).toBe(true);
    expect(byOauth).toBe(true);
  });

  it("does not count a blank key or a missing slot as a credential", () => {
    expect(hasRealtimeCredential(storeHolding({}), "gemini-live")).toBe(false);
    expect(hasRealtimeCredential(storeHolding({}), "openai")).toBe(false);
    expect(
      hasRealtimeCredential(storeHolding({ [OPENAI_SLOT]: { type: "api_key", key: "" } }), "openai"),
    ).toBe(false);
  });
});

describe("picking the orb's provider", () => {
  it("uses the connected account when nobody has chosen one", async () => {
    const resolved = await resolveRealtimeProvider(
      storeHolding({}, { [OPENAI_SLOT]: "sk-pasted" }),
    );

    expect(resolved).toEqual({ kind: "api-key", key: "sk-pasted", provider: "openai" });
  });

  it("prefers Gemini Live when both are connected and nobody chose", async () => {
    const resolved = await resolveRealtimeProvider(
      storeHolding({}, { [GEMINI_SLOT]: "goog-key", [OPENAI_SLOT]: "sk-pasted" }),
    );

    expect(resolved).toEqual({ kind: "api-key", key: "goog-key", provider: "gemini-live" });
  });

  it("honours a chosen provider even when the other is connected", async () => {
    const resolved = await resolveRealtimeProvider(
      storeHolding({}, { [GEMINI_SLOT]: "goog-key", [OPENAI_SLOT]: "sk-pasted" }),
      "openai",
    );

    expect(resolved).toEqual({ kind: "api-key", key: "sk-pasted", provider: "openai" });
  });

  it("refuses by name rather than falling back to a mouth nobody picked", async () => {
    const resolved = await resolveRealtimeProvider(
      storeHolding({}, { [OPENAI_SLOT]: "sk-pasted" }),
      "gemini-live",
    );

    // Falling through to OpenAI here would hand back a working mouth that is
    // not the one that was asked for, and no way to notice.
    expect(isRefusal(resolved)).toBe(true);
    expect(resolved).toMatchObject({ reason: expect.stringMatching(/Google/) });
  });

  it("names the missing account in the refusal for whichever one was chosen", async () => {
    for (const provider of REALTIME_PROVIDER_IDS) {
      const resolved = await resolveRealtimeProvider(storeHolding({}), provider);

      expect(isRefusal(resolved)).toBe(true);
      const name = REALTIME_PROVIDERS[provider].name;
      const expected = name === "Gemini Live" ? "Google" : "OpenAI";
      expect((resolved as { reason: string }).reason).toContain(expected);
    }
  });

  it("leads with the default provider's wording when nothing is connected", async () => {
    const resolved = await resolveRealtimeProvider(storeHolding({}));

    expect(isRefusal(resolved)).toBe(true);
    expect((resolved as { reason: string }).reason).toBe(
      REALTIME_PROVIDERS[DEFAULT_REALTIME_PROVIDER].missingCredentialReason,
    );
  });

  it("never puts a secret in the refusal", async () => {
    // An unrelated provider's credential is in the store but never accessed by
    // the orb resolver — the refusal must not echo it.
    const resolved = await resolveRealtimeProvider(
      storeHolding({
        anthropic: { type: "oauth", access: "ant-token", refresh: "ant-refresh", expires: 1 },
      }),
    );

    expect(isRefusal(resolved)).toBe(true);
    expect(Object.keys(resolved)).toEqual(["reason"]);
    expect(JSON.stringify(resolved)).not.toContain("ant-token");
    expect(JSON.stringify(resolved)).not.toContain("ant-refresh");
  });
});
