import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The hub is deaf by design, and this suite is the pin that keeps it that way.
 *
 * Segment 06 of the client migration deleted every scrap of audio from this
 * process: the arecord/aplay child processes, the mouth, the utterance bank,
 * the wake gate, the hub-side realtime session. A runtime assertion says
 * nothing about the path a test happened not to take, so — in the style of
 * the widget's boundaries suite — this one reads the shipped source and
 * proves the capabilities are absent, not merely unused.
 */

const SRC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const THIS_FILE = fileURLToPath(import.meta.url);

/** Every TypeScript file the hub ships, this suite excepted. */
function sourceFiles(dir = SRC_ROOT): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(full));
      continue;
    }
    if (!full.endsWith(".ts")) continue;
    if (full === THIS_FILE) continue;
    files.push(full);
  }
  return files;
}

/**
 * Comments stripped before scanning: a docstring recounting the retirement
 * ("the arecord children are gone") must not read as the capability itself,
 * and a capability hidden in real code must not hide behind one.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The modules the retirement deleted. An import of one is a resurrection. */
const DELETED_MODULES = [
  "orb/audio-host",
  "orb/mouth",
  "orb/utterance-bank",
  "orb/host",
  "orb/capture-lifecycle",
  "orb/orb",
  "orb/ear",
  "orb/ear-poc",
  "orb/gate",
  "orb/live-gemini",
  "orb/live",
];

describe("the hub process contains no audio code", () => {
  const files = sourceFiles();

  it("actually scanned the hub's source — an empty list proves nothing", () => {
    // The scan walking zero files would pass every assertion below vacuously.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.endsWith("index.ts"))).toBe(true);
  });

  it("no file spawns an audio child process", () => {
    for (const file of files) {
      const body = code(file);
      expect(body, `${file} reaches for arecord`).not.toMatch(/["'`]arecord["'`]/);
      expect(body, `${file} reaches for aplay`).not.toMatch(/["'`]aplay["'`]/);
    }
  });

  it("no file imports a module the retirement deleted", () => {
    for (const file of files) {
      const body = code(file);
      for (const dead of DELETED_MODULES) {
        const pattern = new RegExp(`from\\s+["'][^"']*${dead}(\\.ts)?["']`);
        expect(body, `${file} imports the deleted ${dead}`).not.toMatch(pattern);
      }
    }
  });

  it("the deleted modules are gone from disk, not renamed or stubbed", () => {
    const orbDir = path.join(SRC_ROOT, "orb");
    const remaining = readdirSync(orbDir).sort();
    // The whole surviving surface, by name. A resurrected file — under its
    // old name or a new one carrying the old job — has to show up here and
    // answer for itself.
    //
    // progress-gate.ts answers: it shares a word with the deleted `orb/gate`
    // and none of its job. The wake gate decided when the hub was listening;
    // this one decides which controller events are worth a sentence, and
    // touches no audio to do it.
    expect(remaining).toEqual([
      "brain.test.ts",
      "brain.ts",
      "credentials.test.ts",
      "credentials.ts",
      "deaf.test.ts",
      "face-source.test.ts",
      "face-source.ts",
      "index.ts",
      "orb-mouth.test.ts",
      "orb-page.test.ts",
      "orb-webgl.test.ts",
      "progress-gate.test.ts",
      "progress-gate.ts",
      "realtime-settings.test.ts",
      "realtime-settings.ts",
      "routes.test.ts",
      "routes.ts",
      "token-mint.test.ts",
      "token-mint.ts",
    ]);
  });
});
