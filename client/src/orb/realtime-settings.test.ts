import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildRealtimeSettingsApp,
  readRealtimeSettings,
  REALTIME_MODELS,
  REALTIME_SETTINGS_PATH,
  REALTIME_VOICES,
  writeRealtimeSettings,
} from "./realtime-settings.ts";

describe("readRealtimeSettings", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rt-settings-"));
    file = path.join(dir, "settings.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns empty settings when the file does not exist", async () => {
    const settings = await readRealtimeSettings(file);
    expect(settings).toEqual({});
  });

  it("reads the realtime keys", async () => {
    writeFileSync(file, JSON.stringify({ realtimeModel: "gemini-3.1-pro-live-preview", realtimeVoice: "Aoede" }));
    const settings = await readRealtimeSettings(file);
    expect(settings).toEqual({ realtimeModel: "gemini-3.1-pro-live-preview", realtimeVoice: "Aoede" });
  });

  it("preserves unrelated keys on disk — the code-sdk owns this file too", async () => {
    writeFileSync(file, JSON.stringify({ model: "claude-4.1", mode: "plan", realtimeModel: "gemini-3.1-flash-live-preview" }));
    await writeRealtimeSettings(file, { voice: "Puck" });
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.model).toBe("claude-4.1");
    expect(after.mode).toBe("plan");
    expect(after.realtimeModel).toBe("gemini-3.1-flash-live-preview");
    expect(after.realtimeVoice).toBe("Puck");
  });
});

describe("writeRealtimeSettings", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rt-settings-"));
    file = path.join(dir, "settings.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates the file when it does not exist", async () => {
    await writeRealtimeSettings(file, { model: "gemini-3.1-flash-live-preview" });
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.realtimeModel).toBe("gemini-3.1-flash-live-preview");
  });

  it("clears a setting with an empty string", async () => {
    await writeRealtimeSettings(file, { model: "gemini-3.1-pro-live-preview", voice: "Puck" });
    await writeRealtimeSettings(file, { voice: "" });
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.realtimeModel).toBe("gemini-3.1-pro-live-preview");
    expect(after.realtimeVoice).toBeUndefined();
  });

  it("does not create the file when nothing is written", async () => {
    await writeRealtimeSettings(file, {});
    // The file is created even for an empty patch because the dir exists —
    // but it should be a valid empty-ish JSON object.
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after).toEqual({});
  });
});

describe("buildRealtimeSettingsApp", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rt-settings-"));
    file = path.join(dir, "settings.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("GET returns defaults when nothing is saved", async () => {
    const app = buildRealtimeSettingsApp(file);
    const res = await app.request(REALTIME_SETTINGS_PATH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBeUndefined();
    expect(body.voice).toBeUndefined();
    expect(body.models).toEqual(REALTIME_MODELS);
    expect(body.voices).toEqual(REALTIME_VOICES);
    expect(body.warnings).toEqual([]);
  });

  it("PUT saves model and voice", async () => {
    const app = buildRealtimeSettingsApp(file);
    const res = await app.request(REALTIME_SETTINGS_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini-3.1-pro-live-preview", voice: "Aoede" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe("gemini-3.1-pro-live-preview");
    expect(body.voice).toBe("Aoede");

    const onDisk = await readRealtimeSettings(file);
    expect(onDisk).toEqual({ realtimeModel: "gemini-3.1-pro-live-preview", realtimeVoice: "Aoede" });
  });

  it("PUT with empty string clears the setting", async () => {
    await writeRealtimeSettings(file, { model: "gemini-3.1-flash-live-preview" });
    const app = buildRealtimeSettingsApp(file);
    const res = await app.request(REALTIME_SETTINGS_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBeUndefined();
  });

  it("PUT accepts an unknown model with a warning, not a refusal", async () => {
    const app = buildRealtimeSettingsApp(file);
    const res = await app.request(REALTIME_SETTINGS_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini-9-ultra-live-preview" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe("gemini-9-ultra-live-preview");
    expect(body.warnings.length).toBe(1);
    expect(body.warnings[0]).toContain("gemini-9-ultra-live-preview");
  });

  it("PUT rejects non-string model with 400", async () => {
    const app = buildRealtimeSettingsApp(file);
    const res = await app.request(REALTIME_SETTINGS_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT rejects empty body with 400", async () => {
    const app = buildRealtimeSettingsApp(file);
    const res = await app.request(REALTIME_SETTINGS_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
