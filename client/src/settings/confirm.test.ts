/**
 * The acceptance suite for the yes that is the click.
 *
 * The interesting cases are all failures: the change that was asked for and
 * never confirmed, the confirmation that arrived too late, the one that was
 * already used, and the one that was never minted at all. A gate that only
 * works when everybody cooperates is not a gate.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";

import { AuthStorageCredentialStore } from "../auth/credentials.ts";
import { InMemoryLoginSessionStore } from "../auth/login-sessions.ts";
import { ProviderLoginService } from "../auth/service.ts";
import type { ProviderLoginFlows } from "../auth/flows.ts";
import { FileSettingsAudit, MemorySettingsAudit, SETTINGS_AUDIT_FILE } from "./audit.ts";
import { ConfirmationError, ConfirmationStore } from "./confirm.ts";
import { SettingsGate, type PendingResult } from "./gate.ts";
import { MemoryPreferenceStore } from "./preferences.ts";
import { SettingsError, SettingsService } from "./service.ts";

const A_KEY = "SENTINEL-confirm-api-key";

const FLOWS = {
  startAnthropicLogin: async () => ({ url: "https://example.invalid/consent", verifier: "v" }),
  startCodexDeviceLogin: async () => ({
    url: "https://example.invalid/device",
    userCode: "WXYZ-1234",
    instructions: "Enter the code.",
    intervalMs: 1000,
    deadlineAt: Date.now() + 600_000,
    state: {},
  }),
  completeAnthropicLogin: async () => {
    throw new Error("not exercised here");
  },
  pollCodexDeviceLogin: async () => ({ status: "pending", nextPollMs: 1000 }),
} as unknown as ProviderLoginFlows;

describe("the confirmation gate", () => {
  let dir: string;
  let storage: AuthStorage;
  let credentials: AuthStorageCredentialStore;
  let preferences: MemoryPreferenceStore;
  let audit: MemorySettingsAudit;
  let clock: number;
  let gate: SettingsGate;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comcon-confirm-"));
    storage = new AuthStorage(join(dir, "auth.json"));
    credentials = new AuthStorageCredentialStore(storage);
    preferences = new MemoryPreferenceStore();
    audit = new MemorySettingsAudit();
    clock = 1_000_000;

    gate = new SettingsGate({
      audit,
      confirmations: new ConfirmationStore({ now: () => clock, ttlMs: 60_000 }),
      settings: new SettingsService({
        voiceCredentials: storage,
        preferences,
        login: new ProviderLoginService({
          sessions: new InMemoryLoginSessionStore(),
          credentials,
          flows: FLOWS,
        }),
      }),
    });
  });

  afterEach(() => {
    delete process.env["OPENAI_API_KEY"];
    rmSync(dir, { recursive: true, force: true });
  });

  function askForVoice(): PendingResult {
    credentials.connectApiKey("openai", A_KEY);
    return gate.requestVoiceProvider("openai");
  }

  it("stages a widening change instead of making it, and echoes the exact change", () => {
    const pending = askForVoice();

    expect(pending.status).toBe("needs-confirmation");
    expect(pending.echo).toBe("You want me to use OpenAI for the voice — yes?");
    // The point of the whole mechanism: asking did not change anything.
    expect(preferences.read()).toEqual({});
    expect(audit.entries()).toEqual([]);
  });

  it("makes the change once the yes arrives, and records what was confirmed", async () => {
    const pending = askForVoice();

    const applied = await gate.confirm(pending.token, "owner-1", "settings-page");

    expect(applied.status).toBe("applied");
    expect(preferences.read()).toEqual({ voiceProvider: "openai" });
    expect(audit.entries()).toEqual([
      expect.objectContaining({
        change: "selectVoiceProvider",
        target: "openai",
        surface: "settings-page",
        authorised: "explicit-yes",
        echo: "You want me to use OpenAI for the voice — yes?",
      }),
    ]);
  });

  it("refuses a confirmation handle it never minted", async () => {
    askForVoice();

    await expect(gate.confirm("not-a-real-token", "owner-1", "conversation")).rejects.toThrow(
      ConfirmationError,
    );
    expect(preferences.read()).toEqual({});
    expect(audit.entries()).toEqual([]);
  });

  it("refuses to spend the same yes twice", async () => {
    const pending = askForVoice();
    await gate.confirm(pending.token, "owner-1", "conversation");

    await expect(gate.confirm(pending.token, "owner-1", "conversation")).rejects.toThrow(
      /no change waiting/,
    );
    expect(audit.entries()).toHaveLength(1);
  });

  it("refuses a yes that arrives after the change went stale", async () => {
    const pending = askForVoice();
    clock += 60_001;

    await expect(gate.confirm(pending.token, "owner-1", "conversation")).rejects.toThrow(/expired/);
    expect(preferences.read()).toEqual({});
    expect(audit.entries()).toEqual([]);
  });

  it("drops a staged change on a no, and leaves nothing behind to confirm later", async () => {
    const pending = askForVoice();

    expect(gate.decline(pending.token)).toBe(true);
    expect(gate.pendingCount).toBe(0);
    await expect(gate.confirm(pending.token, "owner-1", "conversation")).rejects.toThrow(ConfirmationError);
    expect(audit.entries()).toEqual([]);
  });

  it("refuses to stage a provider this machine has no credential for", () => {
    expect(() => gate.requestVoiceProvider("openai")).toThrow(SettingsError);
    expect(gate.pendingCount).toBe(0);
  });

  it("narrows without a confirmation fight, and still writes the record", () => {
    credentials.connectApiKey("openai", A_KEY);

    const applied = gate.disconnectAccount("openai", "conversation");

    expect(applied.status).toBe("applied");
    expect(credentials.status("openai").connected).toBe(false);
    expect(audit.entries()).toEqual([
      expect.objectContaining({
        change: "disconnectAccount",
        target: "openai",
        authorised: "narrowing",
      }),
    ]);
  });

  it("gives each staged change its own handle, so a yes cannot land on the wrong one", () => {
    credentials.connectApiKey("openai", A_KEY);
    const voice = gate.requestVoiceProvider("openai");
    const account = gate.requestAccountConnect("anthropic");

    expect(voice.token).not.toBe(account.token);
    expect(account.echo).toBe("You want me to start signing in to Anthropic — yes?");
    expect(gate.pendingCount).toBe(2);
  });

  it("appends the record to a file that survives the object that wrote it", () => {
    // The in-memory audit the rest of this suite uses proves the gate calls it.
    // This proves the thing that actually ships writes something a person can
    // read next week, in the format it claims: one JSON line per change.
    const file = new FileSettingsAudit(dir);
    const onDisk = new SettingsGate({
      audit: file,
      settings: new SettingsService({
        voiceCredentials: storage,
        preferences,
        login: new ProviderLoginService({
          sessions: new InMemoryLoginSessionStore(),
          credentials,
          flows: FLOWS,
        }),
      }),
    });

    onDisk.disconnectAccount("openai", "settings-page");
    onDisk.disconnectAccount("anthropic", "conversation");

    const raw = readFileSync(join(dir, SETTINGS_AUDIT_FILE), "utf8");
    expect(raw.trimEnd().split("\n")).toHaveLength(2);
    expect(new FileSettingsAudit(dir).entries().map((entry) => entry.target)).toEqual([
      "openai",
      "anthropic",
    ]);
  });

  it("never writes a credential into the audit record", async () => {
    const pending = askForVoice();
    await gate.confirm(pending.token, "owner-1", "conversation");
    gate.disconnectAccount("openai", "conversation");

    expect(JSON.stringify(audit.entries())).not.toContain(A_KEY);
  });
});
