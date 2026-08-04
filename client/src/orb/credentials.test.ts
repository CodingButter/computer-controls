import { describe, expect, it, vi } from "vitest";
import type { AuthCredential } from "@mastra/code-sdk/auth/types";

import { GOOGLE_PROVIDER_ID, isRefusal, orbAvailability, resolveOrbCredential } from "./credentials.ts";

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

describe("resolving the credential the orb may use", () => {
  it("uses a pasted Google key as it stands", async () => {
    const resolved = await resolveOrbCredential(
      storeHolding({}, { [GOOGLE_PROVIDER_ID]: "goog-pasted" }),
    );

    expect(resolved).toEqual({ kind: "api-key", key: "goog-pasted", provider: "gemini-live" });
  });

  it("reads the key out of the same store the sign-in surface writes to", async () => {
    const store = storeHolding({
      [GOOGLE_PROVIDER_ID]: { type: "api_key", key: "from-auth-json" },
    });

    await expect(resolveOrbCredential(store)).resolves.toEqual({
      kind: "api-key",
      key: "from-auth-json",
      provider: "gemini-live",
    });
  });

  it("asks the store to refresh an OAuth token rather than reading it raw", async () => {
    const store = storeHolding({
      [GOOGLE_PROVIDER_ID]: { type: "oauth", access: "stale", refresh: "r", expires: 0 },
    });
    store.getApiKey.mockResolvedValue("fresh");

    await expect(resolveOrbCredential(store)).resolves.toEqual({
      kind: "chatgpt-oauth",
      key: "fresh",
      provider: "gemini-live",
    });
    expect(store.getApiKey).toHaveBeenCalledWith(GOOGLE_PROVIDER_ID);
  });

  it("refuses with a reason when no Google account is connected", async () => {
    const resolved = await resolveOrbCredential(
      storeHolding({ anthropic: { type: "api_key", key: "sk-ant" } }),
    );

    expect(isRefusal(resolved)).toBe(true);
    expect((resolved as { reason: string }).reason).toMatch(/Google/);
  });

  it("says the text chat still works, because no key must not read as broken", async () => {
    const resolved = await resolveOrbCredential(storeHolding({}));

    expect((resolved as { reason: string }).reason).toMatch(/typing still works/i);
  });

  it("never puts a secret in the refusal", async () => {
    const resolved = await resolveOrbCredential(
      storeHolding({
        anthropic: { type: "oauth", access: "ant-token", refresh: "ant-refresh", expires: 1 },
      }),
    );

    expect(Object.keys(resolved)).toEqual(["reason"]);
    expect(JSON.stringify(resolved)).not.toContain("ant-token");
    expect(JSON.stringify(resolved)).not.toContain("ant-refresh");
  });

  it("turns the resolution into something a page can render", async () => {
    const enabled = orbAvailability({ kind: "api-key", key: "k", provider: "gemini-live" });
    const disabled = orbAvailability({ reason: "no key" });

    expect(enabled).toEqual({ enabled: true });
    expect(disabled).toEqual({ enabled: false, reason: "no key" });
    // The key never reaches the page.
    expect(JSON.stringify(enabled)).not.toContain("k");
  });
});
