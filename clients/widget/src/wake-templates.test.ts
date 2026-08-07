import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  DEFAULT_WAKE_TEMPLATES,
  decodeWakeTemplates,
  encodeWakeTemplates,
  readWakeTemplates,
  writeWakeTemplates,
} from "./wake-templates.js";

/**
 * How the user's own wake word is remembered, checked without a microphone.
 *
 * Same shape as the tray-state suite for the same reason: the reading and
 * writing live in a plain module, so they can be wrong on a machine with no
 * display and no audio — where this suite runs. What matters is the failure
 * posture: every way this file can be missing or mangled must land on the
 * defaults, because a widget that crashed over its own templates file would be
 * a resident client the user has to resurrect by hand, and the recording they
 * cannot redo must not be forfeit to the recording that sits beside it.
 */

const template = (overrides: Partial<Record<string, unknown>> = {}) => ({
  phrase: "hey mastra",
  createdAt: "2026-08-07T00:00:00.000Z",
  frames: [[0.1, 0.2, 0.3]],
  sampleRate: 16000,
  ...overrides,
});

describe("the defaults", () => {
  test("no templates, not enrolled", () => {
    // A fresh install has heard nothing yet; enrollment is what fills this.
    expect(DEFAULT_WAKE_TEMPLATES).toEqual({ templates: [], enrolled: false });
  });

  test("an absent file is a first run", () => {
    const state = readWakeTemplates(path.join(tmpdir(), "nowhere", "wake-templates.json"));
    expect(state).toEqual(DEFAULT_WAKE_TEMPLATES);
  });
});

describe("reading it back", () => {
  let dir: string;
  const file = () => path.join(dir, "wake-templates.json");

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "wake-templates-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("what was written is what comes back", () => {
    const state = { templates: [template()], enrolled: true };
    writeWakeTemplates(file(), state);
    expect(readWakeTemplates(file())).toEqual(state);
  });

  test("writing creates the directory it needs", () => {
    const nested = path.join(dir, "made", "up", "wake-templates.json");
    writeWakeTemplates(nested, { templates: [template()], enrolled: true });
    expect(existsSync(nested)).toBe(true);
    expect(readWakeTemplates(nested).templates).toHaveLength(1);
  });

  test("a file that is not JSON is the defaults", () => {
    writeFileSync(file(), "not json at all");
    expect(readWakeTemplates(file())).toEqual(DEFAULT_WAKE_TEMPLATES);
  });

  test("a file that is JSON but not a templates object is the defaults", () => {
    for (const raw of ['"a string"', "42", "null", "[]"]) {
      writeFileSync(file(), raw);
      expect(readWakeTemplates(file())).toEqual(DEFAULT_WAKE_TEMPLATES);
    }
  });

  test("a mangled template is dropped, a good one beside it survives", () => {
    // The user's surviving recording is not forfeit because its neighbour got
    // hand-edited into noise. Field-by-field, not all-or-nothing.
    writeFileSync(
      file(),
      JSON.stringify({
        templates: [template(), { phrase: 123, createdAt: "x", frames: "nope", sampleRate: "no" }],
        enrolled: true,
      }),
    );
    const state = readWakeTemplates(file());
    expect(state.templates).toHaveLength(1);
    expect(state.templates[0].phrase).toBe("hey mastra");
  });

  test("a template with a non-finite frame value is rejected", () => {
    writeFileSync(
      file(),
      JSON.stringify({ templates: [template({ frames: [[0.1, NaN, 0.3]] })], enrolled: true }),
    );
    expect(readWakeTemplates(file()).templates).toHaveLength(0);
  });

  test("enrolled defaults to whether any templates survived", () => {
    writeFileSync(file(), JSON.stringify({ templates: [template()] }));
    expect(readWakeTemplates(file()).enrolled).toBe(true);

    writeFileSync(file(), JSON.stringify({ templates: [] }));
    expect(readWakeTemplates(file()).enrolled).toBe(false);
  });

  test("a failed write is silent, and the templates are still templates for this run", () => {
    writeFileSync(path.join(dir, "occupied"), "");
    expect(() =>
      writeWakeTemplates(path.join(dir, "occupied", "wake-templates.json"), DEFAULT_WAKE_TEMPLATES),
    ).not.toThrow();
  });
});

describe("what lands on disk", () => {
  test("templates and enrolled, and nothing else smuggled in", () => {
    expect(
      JSON.parse(encodeWakeTemplates({ templates: [template()], enrolled: true })),
    ).toEqual({ templates: [template()], enrolled: true });
  });

  test("whatever truthiness arrives, booleans and arrays leave", () => {
    const parsed = JSON.parse(
      encodeWakeTemplates({ templates: [template()], enrolled: 1 as unknown as boolean }),
    );
    expect(parsed.enrolled).toBe(true);
  });

  test("the write is a plain rewrite of the whole file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wake-templates-"));
    const file = path.join(dir, "wake-templates.json");
    writeWakeTemplates(file, { templates: [template()], enrolled: true });
    writeWakeTemplates(file, { templates: [template(), template()], enrolled: true });
    expect(readFileSync(file, "utf8")).toBe(
      encodeWakeTemplates({ templates: [template(), template()], enrolled: true }),
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
