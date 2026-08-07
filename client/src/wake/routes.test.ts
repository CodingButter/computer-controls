import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildWakeApp, WAKE_TEMPLATES_PATH } from "./routes.ts";
import { ENROLLED_WAKE_WEIGHT } from "../live/fingerprint.ts";
import {
  enrolledTemplates,
  FACTORY_TEMPLATES,
  FileWakeTemplateStore,
  parseWakeTemplateState,
  WAKE_PHRASE,
  WAKE_TEMPLATES_FILE,
  type WakeTemplateState,
} from "./templates.ts";

const frames = (n = 3) => Array.from({ length: n }, (_, i) => [i, i + 0.5, -i]);

const take = (over: Record<string, unknown> = {}) => ({
  phrase: WAKE_PHRASE,
  createdAt: "2026-08-07T00:00:00.000Z",
  frames: frames(),
  sampleRate: 16_000,
  ...over,
});

function memoryStore(initial: WakeTemplateState = parseWakeTemplateState({})) {
  let state = initial;
  return {
    read: () => state,
    save: (next: WakeTemplateState) => {
      state = parseWakeTemplateState(next);
      return state;
    },
  };
}

describe("the wake template store", () => {
  it("answers a stranger before anyone has enrolled, and says nobody has", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wake-"));
    const state = new FileWakeTemplateStore(dir).read();
    expect(state.phrase).toBe(WAKE_PHRASE);
    // A hub out of the box is not deaf: it ships shapes of the phrase.
    expect(state.templates).toEqual(FACTORY_TEMPLATES);
    expect(state.templates.length).toBeGreaterThan(0);
    // But nobody's own voice is in there, which is what "enrolled" means.
    expect(state.enrolled).toBe(false);
    expect(enrolledTemplates(state)).toHaveLength(0);
  });

  it("keeps the takes it can read when one sibling is malformed", () => {
    const stored = parseWakeTemplateState({
      templates: [take(), { phrase: 1, frames: "nope", sampleRate: "no" }, take()],
    });
    expect(stored.templates).toHaveLength(2);
    expect(stored.enrolled).toBe(true);
  });

  it("refuses frames that are not finite numbers", () => {
    expect(parseWakeTemplateState({ templates: [take({ frames: [[0, NaN]] })] }).templates).toEqual(
      [],
    );
  });

  it("gives every stored take an identity and a timestamp even when the client omits them", () => {
    const [stored] = parseWakeTemplateState({ templates: [{ frames: frames(), sampleRate: 16_000 }] })
      .templates;
    expect(stored?.id).toMatch(/^wake-/);
    expect(Date.parse(stored?.createdAt ?? "")).not.toBeNaN();
    expect(stored?.phrase).toBe(WAKE_PHRASE);
  });

  it("never calls a hub enrolled on an empty bank, however the body is dressed", () => {
    expect(parseWakeTemplateState({ enrolled: true, templates: [] }).enrolled).toBe(false);
  });

  it("survives a corrupt file by leaving the person able to enrol again", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wake-"));
    writeFileSync(path.join(dir, WAKE_TEMPLATES_FILE), "{ not json", "utf8");
    expect(new FileWakeTemplateStore(dir).read().enrolled).toBe(false);
  });

  it("persists the person's takes and nothing else, then hands back both banks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wake-"));
    const store = new FileWakeTemplateStore(dir);
    const saved = store.save(
      parseWakeTemplateState({ templates: [...FACTORY_TEMPLATES, take()] }),
    );

    // The factory bank ships with the code. Freezing today's copy into a
    // person's file would mean they never get a better one.
    const onDisk = JSON.parse(readFileSync(path.join(dir, WAKE_TEMPLATES_FILE), "utf8"));
    expect(onDisk.templates).toHaveLength(1);
    expect(onDisk.templates[0].source).toBe("enrolled");
    expect(onDisk.templates[0].weight).toBe(ENROLLED_WAKE_WEIGHT);

    // What a listening client gets is one bank: the floor plus the owner.
    expect(saved.enrolled).toBe(true);
    expect(enrolledTemplates(saved)).toHaveLength(1);
    expect(saved.templates).toHaveLength(FACTORY_TEMPLATES.length + 1);
    expect(store.read().templates).toHaveLength(FACTORY_TEMPLATES.length + 1);
  });

  it("weighs the owner's voice above the factory floor, whatever a client sends", () => {
    const stored = parseWakeTemplateState({
      templates: [take({ weight: 99 }), take({ weight: 0.1 })],
    });
    // A client cannot promote itself above the owner, nor demote itself below
    // the shipped shapes: enrolment is the claim, and the hub prices it.
    expect(stored.templates.map((t) => t.weight)).toEqual([
      ENROLLED_WAKE_WEIGHT,
      ENROLLED_WAKE_WEIGHT,
    ]);
    expect(ENROLLED_WAKE_WEIGHT).toBeGreaterThan(1);
    expect(FACTORY_TEMPLATES.every((t) => t.weight === undefined)).toBe(true);
  });
});

describe("the wake routes", () => {
  it("refuses a body whose only templates are the bank it was handed", async () => {
    const store = memoryStore(parseWakeTemplateState({ templates: [] }));
    const app = buildWakeApp(store);
    const res = await app.request(WAKE_TEMPLATES_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templates: FACTORY_TEMPLATES.slice(0, 2) }),
    });
    // Nothing of the person's is in there, so nothing was enrolled — and
    // saying otherwise to somebody standing at a microphone is the failure.
    expect(res.status).toBe(422);
  });

  it("hands a client the bank it should compare against", async () => {
    const app = buildWakeApp(memoryStore(parseWakeTemplateState({ templates: [take()] })));
    const res = await app.request(WAKE_TEMPLATES_PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WakeTemplateState;
    expect(body.enrolled).toBe(true);
    expect(body.templates[0]?.frames).toHaveLength(3);
  });

  it("stores an enrolment and answers with what it stored", async () => {
    const store = memoryStore();
    const app = buildWakeApp(store);
    const res = await app.request(WAKE_TEMPLATES_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templates: [take(), take(), take()] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WakeTemplateState).templates).toHaveLength(3);
    expect(store.read().enrolled).toBe(true);
  });

  it("refuses a save that would silently un-enrol the person doing it", async () => {
    const store = memoryStore(parseWakeTemplateState({ templates: [take()] }));
    const app = buildWakeApp(store);
    const res = await app.request(WAKE_TEMPLATES_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templates: [{ frames: "nope" }] }),
    });
    expect(res.status).toBe(422);
    expect(store.read().templates).toHaveLength(1);
  });

  it("says so plainly when the body is not JSON at all", async () => {
    const res = await buildWakeApp(memoryStore()).request(WAKE_TEMPLATES_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
  });
});
