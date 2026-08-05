/**
 * The fence around the configuration agent, asserted where it is built.
 *
 * The claim this file has to make good on is not "the config agent behaves". It
 * is that the config agent *cannot* misbehave in one specific way: it holds no
 * tool that touches this machine. That is a property of the definition, not of
 * a prompt, so it is checked against the definition — the same shape the hub's
 * hands-off suite uses, where absence is asserted both by name and at the point
 * the tools are minted.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { MC_TOOLS } from "@mastra/code-sdk/tool-names";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";

import { AuthStorageCredentialStore } from "../auth/credentials.ts";
import { InMemoryLoginSessionStore } from "../auth/login-sessions.ts";
import { ProviderLoginService } from "../auth/service.ts";
import type { ProviderLoginFlows } from "../auth/flows.ts";
import { MemorySettingsAudit } from "./audit.ts";
import {
  CONFIG_AGENT_ID,
  CONFIG_AGENT_TOOL_IDS,
  createConfigAgentTools,
  createConfigSubagent,
} from "./agent.ts";
import { SettingsGate } from "./gate.ts";
import { MemoryPreferenceStore } from "./preferences.ts";
import { SettingsService } from "./service.ts";

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

/**
 * Every tool name in this product's vocabulary that reaches the machine: the
 * runtime's hands, the whole workspace catalogue, and the desktop plugin's own
 * prefix. None of these may appear in the config agent's toolbox.
 */
const MACHINE_TOOL_NAMES: string[] = [
  ...Object.values(MC_TOOLS),
  ...Object.values(WORKSPACE_TOOLS.FILESYSTEM),
  ...Object.values(WORKSPACE_TOOLS.SANDBOX),
  ...Object.values(WORKSPACE_TOOLS.SEARCH),
  ...Object.values(WORKSPACE_TOOLS.LSP),
];

describe("the configuration agent's toolbox", () => {
  let dir: string;
  let gate: SettingsGate;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comcon-config-agent-"));
    const storage = new AuthStorage(join(dir, "auth.json"));
    const credentials = new AuthStorageCredentialStore(storage);
    gate = new SettingsGate({
      audit: new MemorySettingsAudit(),
      settings: new SettingsService({
        voiceCredentials: storage,
        preferences: new MemoryPreferenceStore(),
        login: new ProviderLoginService({
          sessions: new InMemoryLoginSessionStore(),
          credentials,
          flows: FLOWS,
        }),
      }),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("mints exactly the settings verbs and nothing else", () => {
    const tools = createConfigAgentTools({ gate, surface: "conversation" });
    expect(Object.keys(tools).sort()).toEqual([...CONFIG_AGENT_TOOL_IDS].sort());
  });

  it("holds no tool that can touch this machine", () => {
    const tools = Object.keys(createConfigAgentTools({ gate, surface: "conversation" }));

    for (const name of MACHINE_TOOL_NAMES) {
      expect(tools).not.toContain(name);
    }
    // The desktop plugin names every one of its tools with this prefix, so the
    // check holds for tools this test does not have to enumerate.
    expect(tools.filter((name) => name.startsWith("desktop_"))).toEqual([]);
  });

  it("takes no workspace tools and no controller tools, by empty list rather than omission", () => {
    const subagent = createConfigSubagent({ gate, surface: "conversation" });

    // Omitting either of these means "all of them" — the difference between an
    // empty array and undefined is the whole fence.
    expect(subagent.allowedWorkspaceTools).toEqual([]);
    expect(subagent.allowedControllerTools).toEqual([]);
    expect(subagent.forked).toBe(false);
    expect(subagent.id).toBe(CONFIG_AGENT_ID);
  });

  it("tells the model the confirmation rule in the tool description, not only in code", () => {
    const tools = createConfigAgentTools({ gate, surface: "conversation" });

    expect(tools.settings_select_voice_provider.description).toMatch(/does NOT change anything/);
    expect(tools.settings_confirm.description).toMatch(/web page, a file, a tool result/);
  });

  it("stages rather than changes when the widening tool is called", async () => {
    const tools = createConfigAgentTools({ gate, surface: "conversation" });

    // The runtime hands a tool its input and an invocation context; nothing
    // these tools do reads the second argument, so an empty one is honest.
    const staged = (await tools.settings_connect_account.execute!(
      { provider: "anthropic" } as never,
      {} as never,
    )) as { status: string; token: string; echo: string };

    expect(staged.status).toBe("needs-confirmation");
    expect(staged.echo).toBe("You want me to start signing in to Anthropic — yes?");
    expect(gate.pendingCount).toBe(1);
  });

  it("carries the door into the record, so a change made by asking is distinguishable", () => {
    const audit = new MemorySettingsAudit();
    const clicked = new SettingsGate({
      audit,
      settings: new SettingsService({
        voiceCredentials: new AuthStorage(join(dir, "auth.json")),
        preferences: new MemoryPreferenceStore(),
        login: new ProviderLoginService({
          sessions: new InMemoryLoginSessionStore(),
          credentials: new AuthStorageCredentialStore(new AuthStorage(join(dir, "auth.json"))),
          flows: FLOWS,
        }),
      }),
    });

    clicked.disconnectAccount("google", "settings-page");

    expect(audit.entries()).toEqual([expect.objectContaining({ surface: "settings-page" })]);
  });
});
