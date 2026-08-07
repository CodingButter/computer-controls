#!/usr/bin/env node
/**
 * Turn one WAV into one wake template, stored in the user's data dir.
 *
 * This is the backend the enrollment UI is built around: a recorded "hey
 * mastra" take, captured as 16 kHz mono PCM16, becomes a template that the
 * scorer weighs above the factory fingerprint set. The UI drives the same
 * `extractFeatures` live; this script does the same job offline, so a take
 * recorded anywhere — a handheld recorder, another machine's mic — can be
 * enrolled by pointing the CLI at its WAV.
 *
 * No audio dependency: Node ships no WAV decoder, and the format we accept is a
 * single, narrow slice (RIFF, PCM, mono, 16-bit), so the header is parsed by
 * hand. A file that is not that slice is refused with a clear message rather
 * than coerced.
 *
 * Usage:
 *   node scripts/enroll-wake-sample.mjs \
 *     --wav ./take.wav \
 *     --phrase "hey mastra" \
 *     --data <userData>/wake-templates.json
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractFeatures } from "../src/wake-score.js";
import { readWakeTemplates, writeWakeTemplates } from "../src/wake-templates.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Parse a minimal RIFF WAV header and return its 16-bit mono PCM payload.
 *
 * RIFF is a chunked format: "RIFF" size "WAVE", then sub-chunks. We walk the
 * chunks, read the fmt chunk for the encoding we require (PCM, mono, 16-bit)
 * and the data chunk for the samples. Anything else is refused, not coerced:
 * a stereo or float WAV enrolling as if it were mono would be a template that
 * does not sound like what was recorded.
 *
 * @param {Buffer} buffer
 * @returns {{ samples: Int16Array, sampleRate: number }}
 */
export function decodeWav(buffer) {
  if (buffer.length < 44) throw new Error("file is too small to be a WAV");
  if (buffer.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a RIFF file");
  if (buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAVE file");

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      sampleRate = buffer.readUInt32LE(start + 4);
      channels = buffer.readUInt16LE(start + 2);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (id === "data") {
      dataOffset = start;
      dataLength = size;
      break;
    }
    offset = start + size + (size % 2); // chunks are word-aligned
  }

  if (bitsPerSample !== 16) throw new Error(`expected 16-bit PCM, got ${bitsPerSample}-bit`);
  if (channels !== 1) throw new Error(`expected mono, got ${channels} channels`);
  if (dataOffset === -1) throw new Error("no data chunk found");

  const byteLength = Math.min(dataLength, buffer.length - dataOffset);
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset + dataOffset, byteLength / 2);
  return { samples: new Int16Array(samples), sampleRate };
}

/**
 * Enroll one WAV against a templates file and return what was written.
 *
 * @param {string} wavPath
 * @param {string} dataPath
 * @param {string} phrase
 * @returns {{ template: { phrase: string, createdAt: string, features: number[], sampleRate: number }, total: number }}
 */
export function enrollWav(wavPath, dataPath, phrase) {
  const buffer = readFileSync(resolve(wavPath));
  const { samples, sampleRate } = decodeWav(buffer);
  const features = Array.from(extractFeatures(samples, sampleRate));
  const template = { phrase, createdAt: new Date().toISOString(), features, sampleRate };

  const state = readWakeTemplates(dataPath);
  const templates = [...state.templates, template];
  writeWakeTemplates(dataPath, { templates, enrolled: true });
  return { template, total: templates.length };
}

function parseArgs(argv) {
  const args = { wav: null, phrase: "hey mastra", data: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--wav") args.wav = argv[++i];
    else if (arg === "--phrase") args.phrase = argv[++i];
    else if (arg === "--data") args.data = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.wav || !args.data) {
    process.stdout.write(
      "usage: enroll-wake-sample.mjs --wav <path> --data <wake-templates.json> [--phrase \"hey mastra\"]\n",
    );
    return args.help ? 0 : 1;
  }
  const { template, total } = enrollWav(args.wav, args.data, args.phrase);
  process.stdout.write(
    `enrolled "${template.phrase}" (${template.sampleRate} Hz, ${template.features.length} bins) — ${total} template(s) now stored\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = main();
  if (code) process.exit(code);
}

export { main };
