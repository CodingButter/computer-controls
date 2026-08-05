import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  DEFAULT_TRAY_STATE,
  decodeTrayState,
  encodeTrayState,
  readTrayState,
  writeTrayState,
} from "./tray-state.js";

/**
 * How the tray remembers what it was told, checked without a tray.
 *
 * Same shape as the placement suite and for the same reason: the reading and
 * writing are in a plain module so they can be wrong on a machine with no
 * display, where this suite runs. What matters here is the failure posture —
 * every way this file can be missing or mangled must land on the defaults,
 * because a widget that crashed over its own two-boolean settings file would
 * be a resident client the user has to resurrect by hand.
 */

describe("the defaults", () => {
  test("auto-hide on, disabled off", () => {
    // The product's posture for a fresh install: a face that tidies itself
    // away, and a widget that works because it was installed.
    expect(DEFAULT_TRAY_STATE).toEqual({ autoHide: true, disabled: false });
  });

  test("an absent file is a first run", () => {
    const state = readTrayState(path.join(tmpdir(), "nowhere", "tray-state.json"));
    expect(state).toEqual(DEFAULT_TRAY_STATE);
  });
});

describe("reading it back", () => {
  let dir: string;
  const file = () => path.join(dir, "tray-state.json");

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tray-state-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("what was written is what comes back", () => {
    writeTrayState(file(), { autoHide: false, disabled: true });
    expect(readTrayState(file())).toEqual({ autoHide: false, disabled: true });
  });

  test("every combination survives the round trip", () => {
    for (const autoHide of [true, false]) {
      for (const disabled of [true, false]) {
        writeTrayState(file(), { autoHide, disabled });
        expect(readTrayState(file())).toEqual({ autoHide, disabled });
      }
    }
  });

  test("writing creates the directory it needs", () => {
    const nested = path.join(dir, "made", "up", "tray-state.json");
    writeTrayState(nested, { autoHide: false, disabled: false });
    expect(existsSync(nested)).toBe(true);
    expect(readTrayState(nested).autoHide).toBe(false);
  });

  test("a file that is not JSON is the defaults", () => {
    writeFileSync(file(), "not json at all");
    expect(readTrayState(file())).toEqual(DEFAULT_TRAY_STATE);
  });

  test("a file that is JSON but not a tray state is the defaults", () => {
    for (const raw of ['"a string"', "42", "null", "[]"]) {
      writeFileSync(file(), raw);
      expect(readTrayState(file())).toEqual(DEFAULT_TRAY_STATE);
    }
  });

  test("one mangled field does not forfeit the other", () => {
    // A user who turned auto-hide off keeps that choice even if the other
    // boolean got hand-edited into noise.
    writeFileSync(file(), JSON.stringify({ autoHide: false, disabled: "yes please" }));
    expect(readTrayState(file())).toEqual({ autoHide: false, disabled: false });

    writeFileSync(file(), JSON.stringify({ autoHide: "sometimes", disabled: true }));
    expect(readTrayState(file())).toEqual({ autoHide: true, disabled: true });
  });

  test("a failed write is silent, and the tray is still a tray", () => {
    // Writing into a path that cannot exist (a file where a directory should
    // be) must not throw: the choice is lost, the process is not.
    writeFileSync(path.join(dir, "occupied"), "");
    expect(() =>
      writeTrayState(path.join(dir, "occupied", "tray-state.json"), DEFAULT_TRAY_STATE),
    ).not.toThrow();
  });
});

describe("what lands on disk", () => {
  test("two booleans and nothing else", () => {
    // Deliberately tiny, like the placement file: nothing here for a future
    // feature to smuggle a preference into.
    expect(JSON.parse(encodeTrayState({ autoHide: true, disabled: false }))).toEqual({
      autoHide: true,
      disabled: false,
    });
  });

  test("whatever truthiness arrives, booleans leave", () => {
    const parsed = JSON.parse(
      encodeTrayState({ autoHide: 1 as unknown as boolean, disabled: 0 as unknown as boolean }),
    );
    expect(parsed).toEqual({ autoHide: true, disabled: false });
  });

  test("decode is field-by-field, not all-or-nothing", () => {
    expect(decodeTrayState(JSON.stringify({ disabled: true }))).toEqual({
      autoHide: true,
      disabled: true,
    });
  });

  test("the write is a plain rewrite of the whole file", () => {
    // Pinning the discipline: read it raw and it is exactly the encoding,
    // never an append or a partial update.
    const dir = mkdtempSync(path.join(tmpdir(), "tray-state-"));
    const file = path.join(dir, "tray-state.json");
    writeTrayState(file, { autoHide: true, disabled: true });
    writeTrayState(file, { autoHide: false, disabled: false });
    expect(readFileSync(file, "utf8")).toBe(encodeTrayState({ autoHide: false, disabled: false }));
    rmSync(dir, { recursive: true, force: true });
  });
});
