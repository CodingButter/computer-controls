/**
 * What the settings service will and will not do when nobody is holding a mouse.
 *
 * The credential store is the SDK's real `AuthStorage` writing a real
 * `auth.json` in a temporary directory, and the preference store is a real file
 * on disk, for the same reason the sign-in suite does it: "the setting
 * persisted" should mean bytes, not a spy that agreed it was called.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";

import { AuthStorageCredentialStore } from "../auth/credentials.ts";
import { InMemoryLoginSessionStore } from "../auth/login-sessions.ts";
import { ProviderLoginService } from "../auth/service.ts";
import type { ProviderLoginFlows } from "../auth/flows.ts";
import { FilePreferenceStore, HUB_PREFERENCES_FILE } from "./preferences.ts";
import {
  SETTINGS_CHANGE_DIRECTION,
  SettingsError,
  SettingsService,
  describeChange,
} from "./service.ts";

const A_KEY = "SENTINEL-settings-api-key";

const REFUSING_FLOWS: ProviderLoginFlows = {
  startAnthropicLogin: async () => ({ url: "https://example.invalid/consent", verifier: "v" }),
  completeAnthropicLogin: async () => {
    throw new Error("not exercised here");
  },
  startCodexDeviceLogin: async () => ({
    url: "https://example.invalid/device",
    userCode: "WXYZ-1234",
    instructions: "Enter the code.",
    intervalMs: 1000,
    deadlineAt: Date.now() + 600_000,
    state: {},
  }),
  pollCodexDeviceLogin: async () => ({ status: "pending", nextPollMs: 1000 }),
} as unknown as ProviderLoginFlows;

describe("the settings service", () => {
  let dir: string;
  let storage: AuthStorage;
  let credentials: AuthStorageCredentialStore;
  let preferences: FilePreferenceStore;
  let settings: SettingsService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comcon-settings-"));
    storage = new AuthStorage(join(dir, "auth.json"));
    credentials = new AuthStorageCredentialStore(storage);
    preferences = new FilePreferenceStore(dir);
    settings = new SettingsService({
      voiceCredentials: storage,
      preferences,
      login: new ProviderLoginService({
        sessions: new InMemoryLoginSessionStore(),
        credentials,
        flows: REFUSING_FLOWS,
      }),
    });
  });

  afterEach(() => {
    delete process.env["OPENAI_API_KEY"];
    rmSync(dir, { recursive: true, force: true });
  });

  it("offers no voice provider on a machine with no voice credential", () => {
    expect(settings.listVoiceProviders()).toEqual([]);
  });

  it("refuses to pick a provider this machine has no credential for", () => {
    expect(() => settings.selectVoiceProvider("openai")).toThrow(SettingsError);
    // Nothing was written: a refused change must not leave a setting behind.
    expect(preferences.read()).toEqual({});
  });

  it("saves a picked provider to disk, where the next start will find it", () => {
    credentials.connectApiKey("openai", A_KEY);

    const view = settings.selectVoiceProvider("openai");

    expect(view).toEqual([
      expect.objectContaining({ provider: "openai", selected: true, usable: true }),
    ]);
    expect(preferences.read()).toEqual({ voiceProvider: "openai" });
    expect(JSON.parse(readFileSync(join(dir, HUB_PREFERENCES_FILE), "utf8"))).toEqual({
      voiceProvider: "openai",
    });
  });

  it("raises rather than resetting when the preference file is not JSON", () => {
    writeFileSync(join(dir, HUB_PREFERENCES_FILE), "{ this is not json", "utf8");
    expect(() => preferences.read()).toThrow(/not valid JSON/);
  });

  it("drops a provider name it does not recognise without losing the file", () => {
    writeFileSync(join(dir, HUB_PREFERENCES_FILE), '{"voiceProvider":"gramophone"}', "utf8");
    expect(preferences.read()).toEqual({});
  });

  it("reports accounts without ever carrying a credential's value", () => {
    credentials.connectApiKey("openai", A_KEY);

    const accounts = settings.listAccounts();

    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "openai", connected: true, method: "api-key" }),
        expect.objectContaining({ provider: "anthropic", connected: false }),
      ]),
    );
    expect(JSON.stringify(accounts)).not.toContain(A_KEY);
  });

  it("hands back only what a person has to type to finish a sign-in", async () => {
    const session = await settings.startAccountConnect("owner-1", "openai");

    expect(session).toEqual(
      expect.objectContaining({ url: "https://example.invalid/device", userCode: "WXYZ-1234" }),
    );
    expect(JSON.stringify(session)).not.toContain("SENTINEL");
  });

  it("disconnects an account on request, and the credential is gone", () => {
    credentials.connectApiKey("openai", A_KEY);
    expect(credentials.status("openai").connected).toBe(true);

    expect(settings.disconnectAccount("openai")).toEqual(
      expect.objectContaining({ provider: "openai", connected: false }),
    );
    expect(settings.listVoiceProviders()).toEqual([]);
  });

  it("classifies every change, so nothing reaches the gate unclassified", () => {
    expect(SETTINGS_CHANGE_DIRECTION).toEqual({
      selectVoiceProvider: "widen",
      startAccountConnect: "widen",
      disconnectAccount: "narrow",
    });
  });

  it("echoes a change in words a person can say yes or no to", () => {
    expect(describeChange("selectVoiceProvider", "openai")).toBe("use OpenAI for the voice");
    expect(describeChange("disconnectAccount", "anthropic")).toBe("disconnect Anthropic");
  });
});
