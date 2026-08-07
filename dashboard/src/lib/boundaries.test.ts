import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

/**
 * One microphone, one speaker, in one file.
 *
 * The dashboard opens an `AudioContext` to enrol a wake word, and now plays a
 * cue on it as well. Both live in `wake-capture.ts`, and until this file
 * existed that was true by habit rather than by rule — the widget has a
 * boundaries suite naming the files allowed to reach for audio, but it reads
 * its own directory and has never seen this package. Somebody adding a second
 * beep somewhere else would have broken nothing that anybody could observe.
 *
 * Why it matters here more than tidiness: a context is a live audio device.
 * Two of them means two recording indicators, two teardown paths, and a page
 * that can leave one open after the other has closed. The enrolment page is
 * exactly where a person is watching for the microphone light to go out.
 *
 * The method is the widget's — read the shipped source as text and ask what it
 * names — because the claim is about what exists in the program, not about what
 * happened during one run. A runtime check could only speak for the paths a
 * test took.
 */

/** `.../src`, no trailing separator — names below are cut relative to it. */
const SRC = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/** Every source file in the dashboard, tests excluded — they are not shipped. */
function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      sources(path, found);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    found.push(path.slice(SRC.length + 1));
  }
  return found;
}

/**
 * Prose is not a capability. Several of these files explain why they must not
 * open a context, and a scan that could not tell a comment from a call would
 * fail the very files documenting the rule.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const shipped = sources(SRC).sort();
const code = (name: string) => stripComments(readFileSync(`${SRC}/${name}`, "utf8"));

/** The one file allowed to hold a live audio device, and what it may name. */
const AUDIO_OWNER = "lib/wake-capture.ts";

test("the dashboard's audio device is opened in exactly one file", () => {
  // Reading real files, not an empty directory that would make every assertion
  // below vacuously true.
  expect(shipped).toContain(AUDIO_OWNER);
  expect(shipped).toContain("components/voice/wake-training.tsx");
  expect(shipped.length).toBeGreaterThan(20);

  const waysToOpenAnEar = [
    "getUserMedia",
    "mediaDevices",
    "AudioContext",
    "createMediaStreamSource",
    "AudioWorklet",
    "webkitAudioContext",
    "MediaRecorder",
    "getDisplayMedia",
  ];

  for (const name of shipped) {
    if (name === AUDIO_OWNER) continue;
    const body = code(name);
    for (const call of waysToOpenAnEar) {
      expect(body, `${name} must not reach for ${call}`).not.toContain(call);
    }
  }
});

test("even the file that owns the microphone keeps the doors it never needed shut", () => {
  const body = code(AUDIO_OWNER);
  // Enrolment records to features and drops the samples. Nothing here has any
  // business writing a blob or reading a screen.
  for (const call of ["MediaRecorder", "getDisplayMedia", "webkitAudioContext"]) {
    expect(body, `${AUDIO_OWNER} must not reach for ${call}`).not.toContain(call);
  }
});

test("the cue is played on a context it was handed, never one it opened", () => {
  const body = code(AUDIO_OWNER);
  // `playCue` takes the context as a parameter. If it ever grows its own, this
  // is the line that notices — the whole point of the single owner is that the
  // cue and the capture share one device.
  expect(body).toContain("export function playCue(context: BaseAudioContext");
  expect(body.match(/new AudioContext/g)).toHaveLength(1);
});
