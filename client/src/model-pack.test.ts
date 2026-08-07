import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mastra } from "@mastra/core/mastra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { brainFromGrant, selectBrain } from "../../clients/mastra-plugin/src/scope-brain.ts";
import { buildApp } from "./app.ts";
import { createAgentTurn } from "./chat.ts";
import { resolveClientConfig } from "./config.ts";
import { prepareHub } from "./hub.ts";
import type { ModelPack } from "./model-pack.ts";
import {
  BANNED_MODEL_IDS,
  hubModes,
  MODE_BRAINS,
  modelForTier,
  resolveModelPack,
  THINKING_MODE,
} from "./model-pack.ts";

/**
 * The brain the hub thinks with, and where it came from.
 *
 * Every assertion below is about mechanism rather than about a model name: that
 * the value the turn runs on was chosen in this repository, that a person can
 * read it off the running hub, and that the tiers the desktop side speaks in
 * resolve against the same declaration. Which models the pack names is
 * configuration, and a test that pinned those strings would only rot.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "comcon-pack-"));

let app: ReturnType<typeof buildApp>;
let pack: ModelPack;
let received: { model?: string; mode?: string; modeDefaults?: unknown }[];

beforeAll(async () => {
  const config = resolveClientConfig({ ...process.env, COMCON_CLIENT_ROOT: root });
  const hub = await prepareHub(config);
  pack = hub.modelPack;
  new Mastra(hub.mastraArgs);
  await hub.finalize();

  received = [];
  const chat = createAgentTurn({
    controller: hub.base.controller,
    getSession: hub.getSession,
    mode: THINKING_MODE,
    model: modelForTier(hub.modelPack, MODE_BRAINS[THINKING_MODE]),
    run: ((options: Record<string, unknown>) => {
      received.push(options as never);
      return {
        result: Promise.resolve({
          status: "completed",
          text: "heard",
          threadId: "thread-1",
          toolCalls: [],
          toolResults: [],
          exitCode: 0,
        }),
      };
    }) as never,
  });

  app = buildApp({ chat, uiRoot: config.uiRoot, status: hub.status });
}, 120_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("test_the_hub_declares_its_own_model_instead_of_inheriting_the_sdk_default", async () => {
  const response = await app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "what windows are open?" }),
  });
  expect(response.status).toBe(200);

  const turn = received.at(-1)!;
  // The turn names its model, and the name is the one this repository declared
  // for the tier the chat runs at.
  expect(turn.model).toBe(pack.models[MODE_BRAINS[THINKING_MODE]]);
  // And the runtime's own resolution never gets a vote: no mode defaults are
  // handed down, so there is nothing for a settings file on this machine or a
  // pack that shipped with the SDK to be resolved from.
  expect(turn.modeDefaults).toBeUndefined();
});

test("a saved model choice on this machine does not re-point the hub", async () => {
  // The runtime resolves models from a settings file the TUI writes, and that
  // file wins over a configured mode default. So the hub keeps its own file
  // under its own root: whatever a person picked in the TUI last week is a
  // preference about the TUI, not a decision about which brain holds a desktop.
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "comcon-appdata-"));
  const hubRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comcon-hubroot-"));
  fs.writeFileSync(
    path.join(appData, "settings.json"),
    JSON.stringify({ models: { modeDefaults: { build: "openai/gpt-5.6-sol" } } }),
  );
  const previous = process.env.MASTRA_APP_DATA_DIR;
  process.env.MASTRA_APP_DATA_DIR = appData;

  try {
    const hub = await prepareHub(
      resolveClientConfig({ ...process.env, COMCON_CLIENT_ROOT: hubRoot }),
    );
    new Mastra(hub.mastraArgs);
    await hub.finalize();

    const modes = await hub.base.controller.listModes();
    const build = modes.find((mode) => mode.id === "build");
    expect(build?.defaultModelId).toBe(hub.modelPack.models[MODE_BRAINS.build]);
  } finally {
    if (previous === undefined) delete process.env.MASTRA_APP_DATA_DIR;
    else process.env.MASTRA_APP_DATA_DIR = previous;
    fs.rmSync(appData, { recursive: true, force: true });
    fs.rmSync(hubRoot, { recursive: true, force: true });
  }
}, 120_000);

test("test_health_reports_the_model_that_will_think", async () => {
  const response = await app.request("/api/health");
  const health = (await response.json()) as {
    model: { pack: string; thinking: string; tiers: Record<string, string> };
  };

  expect(health.model.pack).toBe(pack.id);
  // The model health names is the model a turn actually runs on — the same
  // value the chat lane above was handed, not a second copy that could drift.
  expect(health.model.thinking).toBe(received.at(-1)!.model);
  expect(health.model.tiers).toEqual(pack.models);
});

describe("the declaration", () => {
  test("stands when the environment says nothing", () => {
    const declared = resolveModelPack({});
    expect(Object.values(declared.models).every((id) => id.includes("/"))).toBe(true);
    expect(declared.id.length).toBeGreaterThan(0);
  });

  test("re-points a tier when the environment names another model", () => {
    const overridden = resolveModelPack({ COMCON_MODEL_HEAVY: "openai/gpt-5.6-sol" });
    expect(overridden.models.heavy).toBe("openai/gpt-5.6-sol");
    expect(overridden.models.standard).toBe(resolveModelPack({}).models.standard);
  });

  test("refuses to boot on an override that names nothing", () => {
    // Silence means "use what was declared". An empty or half-typed value means
    // somebody tried to choose and failed, and falling through to the runtime's
    // pick would hide exactly that.
    expect(() => resolveModelPack({ COMCON_MODEL_STANDARD: "  " })).toThrow(/standard/);
    expect(() => resolveModelPack({ COMCON_MODEL_MINIMAL: "claude-haiku-4-5" })).toThrow(
      /provider\/model/,
    );
  });

  test("names no model this product refuses to run", () => {
    // The ban is a fact about the product, not about the runtime's catalogue,
    // so it is pinned here rather than left to whoever next edits three strings.
    const declared = resolveModelPack({});
    for (const [tier, id] of Object.entries(declared.models)) {
      expect(BANNED_MODEL_IDS, `the "${tier}" tier`).not.toContain(id);
    }

    // And an override cannot smuggle one back in either.
    expect(() => resolveModelPack({ COMCON_MODEL_STANDARD: BANNED_MODEL_IDS[0] })).toThrow(
      /does not run/,
    );
  });

  test("hands the runtime's modes the models it chose", () => {
    const modes = hubModes(resolveModelPack({}));
    const byId = new Map(modes.map((mode) => [mode.id, mode.defaultModelId]));
    const declared = resolveModelPack({});

    expect(byId.get("build")).toBe(declared.models[MODE_BRAINS.build]);
    expect(byId.get("plan")).toBe(declared.models[MODE_BRAINS.plan]);
    expect(byId.get("fast")).toBe(declared.models[MODE_BRAINS.fast]);
  });
});

test("test_the_scope_brain_tiers_resolve_against_the_declared_pack", () => {
  // The plugin decides how much thinking a scope is worth and refuses to name a
  // model; the pack names the models and has no opinion about scopes. This is
  // the join, and it is the whole of it.
  const narrow = selectBrain({ rank: 0, irreversible: false }, { applications: 1, anchors: 0, unbounded: false });
  const middling = selectBrain({ rank: 1, irreversible: false }, { applications: 2, anchors: 0, unbounded: false });
  const dangerous = selectBrain({ rank: 3, irreversible: true }, { applications: 1, anchors: 0, unbounded: false });
  // A daemon too old to report its scope is the same question with no answer,
  // and the tier logic already spends the most thinking on it — which the pack
  // has to be able to price like any other tier.
  const unreported = brainFromGrant({ ceiling: ["observe", "submit"], operationClasses: ["observe"] });

  expect(modelForTier(pack, narrow.tier)).toBe(pack.models.minimal);
  expect(modelForTier(pack, middling.tier)).toBe(pack.models.standard);
  expect(modelForTier(pack, dangerous.tier)).toBe(pack.models.heavy);
  expect(modelForTier(pack, unreported.tier)).toBe(pack.models.heavy);

  // Re-choosing the pack re-points all three, and the tier logic never moves:
  // the same scopes come back with the same tiers and different models.
  const elsewhere = resolveModelPack({
    COMCON_MODEL_MINIMAL: "openai/gpt-5.4-mini",
    COMCON_MODEL_STANDARD: "openai/gpt-5.6-sol",
    COMCON_MODEL_HEAVY: "openai/gpt-5.6-sol-high",
  });

  expect(modelForTier(elsewhere, narrow.tier)).toBe("openai/gpt-5.4-mini");
  expect(modelForTier(elsewhere, middling.tier)).toBe("openai/gpt-5.6-sol");
  expect(modelForTier(elsewhere, dangerous.tier)).toBe("openai/gpt-5.6-sol-high");
});
