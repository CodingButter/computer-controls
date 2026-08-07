#!/usr/bin/env node
/**
 * Build the factory wake bank: the shapes of "hey mastra" the product knows
 * before it has ever met you.
 *
 * A hub that only wakes on an enrolled voice is a hub that is deaf out of the
 * box, and the first thing a person does with a voice product is talk to it.
 * So the corpus of rendered takes — many voices, many moods, quality-checked
 * when it was generated — is reduced here to the same cepstral frames the gate
 * compares against, and shipped as data.
 *
 * Two decisions worth stating.
 *
 * A person's own takes outrank these. The factory templates carry no weight
 * field, which the gate reads as one; an enrolled take carries more. The bank
 * is the floor, not the ceiling.
 *
 * Not every clip gets in. Taking all of them would multiply the work the gate
 * does on every utterance for voices that mostly agree with each other, so this
 * keeps a bounded number per voice, spread across the moods that voice was
 * rendered in. Breadth across speakers is what a stranger's voice needs;
 * eighteen renderings of the same speaker is not breadth.
 *
 *   node scripts/generate-wake-defaults.mjs [outFile]
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mfcc } from "../public/live/fingerprint.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(here, "../../clients/widget/corpus/positive");
const DEFAULT_OUT = path.resolve(here, "../src/wake/factory-bank.json");

/** Per voice, so one prolific speaker cannot dominate the bank. */
const TAKES_PER_VOICE = 2;

/**
 * Rounded, because the last digits of a float are noise the DTW cannot see and
 * they would triple the size of a file that ships in the product.
 */
const PRECISION = 3;

/**
 * Hand-parsed because a WAV is a header and a block of samples, and a
 * dependency that decodes audio is a dependency that can decode audio.
 * Anything that is not mono 16-bit PCM is refused rather than guessed at: a
 * stereo file read as mono is a template that does not sound like the take.
 */
function decodeWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  let format;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!format) throw new Error("data chunk before fmt chunk");
      if (format.audioFormat !== 1) throw new Error(`not PCM (format ${format.audioFormat})`);
      if (format.channels !== 1) throw new Error(`not mono (${format.channels} channels)`);
      if (format.bitsPerSample !== 16) throw new Error(`not 16-bit (${format.bitsPerSample})`);
      const samples = new Int16Array(size / 2);
      for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(body + i * 2);
      return { samples, sampleRate: format.sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("no data chunk");
}

/** Spread the picks across the moods a voice was rendered in, not the first N alphabetically. */
function spread(files, count) {
  if (files.length <= count) return files;
  const step = files.length / count;
  return Array.from({ length: count }, (_, i) => files[Math.floor(i * step)]);
}

function build() {
  const byVoice = new Map();
  for (const file of readdirSync(CORPUS).filter((f) => f.endsWith(".wav")).sort()) {
    const voice = file.slice(0, file.lastIndexOf("-"));
    if (!byVoice.has(voice)) byVoice.set(voice, []);
    byVoice.get(voice).push(file);
  }

  const templates = [];
  const skipped = [];
  for (const [voice, files] of [...byVoice].sort(([a], [b]) => a.localeCompare(b))) {
    for (const file of spread(files, TAKES_PER_VOICE)) {
      try {
        const { samples, sampleRate } = decodeWav(readFileSync(path.join(CORPUS, file)));
        // Array.from, not map: mfcc hands back Float32Arrays, and a
        // Float32Array serialises to an object with numeric keys that reads
        // back as a template nothing recognises.
        const frames = mfcc(samples, sampleRate).map((frame) =>
          Array.from(frame, (value) => Number(value.toFixed(PRECISION))),
        );
        if (frames.length === 0) throw new Error("no frames");
        templates.push({
          id: `factory-${file.replace(/\.wav$/, "")}`,
          phrase: "hey mastra",
          createdAt: new Date(0).toISOString(),
          frames,
          sampleRate,
        });
      } catch (error) {
        skipped.push(`${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
    void voice;
  }
  return { templates, skipped };
}

const out = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUT;
const { templates, skipped } = build();
if (templates.length === 0) {
  console.error("no factory templates built — refusing to write an empty bank");
  process.exit(1);
}
writeFileSync(out, `${JSON.stringify({ phrase: "hey mastra", templates }, null, 0)}\n`);
const voices = new Set(templates.map((t) => t.id.slice("factory-".length).replace(/-[^-]*$/, "")));
console.log(
  `wrote ${templates.length} factory templates from ${voices.size} voices -> ${path.relative(process.cwd(), out)}`,
);
for (const line of skipped) console.log(`  skipped ${line}`);
