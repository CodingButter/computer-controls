import { describe, expect, it, vi } from "vitest";
import type { AuthCredential } from "@mastra/code-sdk/auth/types";
import {
  OPENAI_PROVIDER_ID,
  isRefusal,
  resolveVoiceCredential,
} from "./credentials.ts";

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

describe("resolving the credential the voice lane may use", () => {
  it("uses a pasted OpenAI key as it stands", async () => {
    const resolved = await resolveVoiceCredential(
      storeHolding({}, { [OPENAI_PROVIDER_ID]: "sk-pasted" }),
    );

    expect(resolved).toEqual({ kind: "api-key", key: "sk-pasted", provider: "openai" });
  });

  it("asks the store for the OAuth token so an expired one is refreshed there, not here", async () => {
    const store = storeHolding({
      [OPENAI_PROVIDER_ID]: {
        type: "oauth",
        access: "stale-access-token",
        refresh: "refresh-token",
        expires: 0,
      },
    });
    store.getApiKey.mockResolvedValue("freshly-refreshed-token");

    const resolved = await resolveVoiceCredential(store);

    expect(resolved).toEqual({
      kind: "chatgpt-oauth",
      key: "freshly-refreshed-token",
      provider: "openai",
    });
    expect(store.getApiKey).toHaveBeenCalledWith(OPENAI_PROVIDER_ID);
  });

  it("keeps the two credential kinds apart, because only one of them is proven", async () => {
    const fromKey = await resolveVoiceCredential(
      storeHolding({}, { [OPENAI_PROVIDER_ID]: "sk-pasted" }),
    );
    const fromLogin = await resolveVoiceCredential(
      storeHolding({
        [OPENAI_PROVIDER_ID]: {
          type: "oauth",
          access: "chatgpt-token",
          refresh: "r",
          expires: Date.now() + 60_000,
        },
      }),
    );

    expect(isRefusal(fromKey) || isRefusal(fromLogin)).toBe(false);
    expect((fromKey as { kind: string }).kind).toBe("api-key");
    expect((fromLogin as { kind: string }).kind).toBe("chatgpt-oauth");
  });

  it("refuses when only an Anthropic credential is connected, and names what is missing", async () => {
    const resolved = await resolveVoiceCredential(
      storeHolding({
        anthropic: {
          type: "oauth",
          access: "anthropic-token",
          refresh: "r",
          expires: Date.now() + 60_000,
        },
      }),
    );

    expect(isRefusal(resolved)).toBe(true);
    expect((resolved as { reason: string }).reason).toMatch(/OpenAI/);
  });

  it("refuses when the OpenAI sign-in cannot be refreshed", async () => {
    const store = storeHolding({
      [OPENAI_PROVIDER_ID]: {
        type: "oauth",
        access: "expired",
        refresh: "r",
        expires: 0,
      },
    });
    store.getApiKey.mockResolvedValue(undefined);

    const resolved = await resolveVoiceCredential(store);

    expect(isRefusal(resolved)).toBe(true);
    expect((resolved as { reason: string }).reason).toMatch(/sign in again/i);
  });

  it("never puts a secret in the refusal", async () => {
    const resolved = await resolveVoiceCredential(
      storeHolding({
        anthropic: {
          type: "oauth",
          access: "anthropic-token",
          refresh: "anthropic-refresh",
          expires: Date.now() + 60_000,
        },
      }),
    );

    expect(Object.keys(resolved)).toEqual(["reason"]);
    expect(JSON.stringify(resolved)).not.toContain("anthropic-token");
    expect(JSON.stringify(resolved)).not.toContain("anthropic-refresh");
  });
});
