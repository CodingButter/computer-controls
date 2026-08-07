#!/usr/bin/env node
/**
 * Measure the case the product actually sells: a person's own three takes.
 *
 * The factory bank is a floor, and a modest one — a stranger's voice compared
 * against other strangers' voices separates weakly, which is what the earlier
 * calibration found and this script's sibling confirms. The claim worth testing
 * is different: does two or three takes of ONE voice recognise more of that same
 * voice, while still refusing everything else?
 *
 * So every voice in the corpus is enrolled in turn — its first takes become the
 * bank, its remaining takes become the held-out positives — and the negatives
 * are every non-wake utterance from every voice. That is the enrolment
 * experiment, run eleven times, and the threshold it prints is the one the gate
 * should carry for an enrolled user.
 *
 *   node scripts/measure-wake-enrolled.mjs <positives-dir> <negatives-dir>
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { mfcc, subsequenceDtw } from "../public/live/fingerprint.js";

const TAKES_ENROLLED = 3;

function decodeWav(buffer) {
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
      if (format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) {
        throw new Error("not mono 16-bit PCM");
      }
      const samples = new Int16Array(size / 2);
      for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(body + i * 2);
      return { samples, sampleRate: format.sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("no data chunk");
}

const framesOf = (file) => {
  const { samples, sampleRate } = decodeWav(readFileSync(file));
  return mfcc(samples, sampleRate);
};

const best = (frames, bank) => bank.reduce((m, t) => Math.min(m, subsequenceDtw(frames, t)), Infinity);

const [positivesDir, negativesDir] = process.argv.slice(2);
if (!positivesDir || !negativesDir) {
  console.error("usage: measure-wake-enrolled.mjs <positives-dir> <negatives-dir>");
  process.exit(2);
}

const byVoice = new Map();
for (const file of readdirSync(positivesDir).filter((f) => f.endsWith(".wav")).sort()) {
  const voice = file.slice(0, file.lastIndexOf("-"));
  if (!byVoice.has(voice)) byVoice.set(voice, []);
  byVoice.get(voice).push(path.join(positivesDir, file));
}

const negativeFrames = readdirSync(negativesDir)
  .filter((f) => f.endsWith(".wav"))
  .sort()
  .map((f) => ({ file: f, frames: framesOf(path.join(negativesDir, f)) }));

const rows = [];
for (const [voice, files] of byVoice) {
  if (files.length <= TAKES_ENROLLED) continue;
  const bank = files.slice(0, TAKES_ENROLLED).map(framesOf);
  const held = files.slice(TAKES_ENROLLED).map((f) => best(framesOf(f), bank)).sort((a, b) => a - b);
  // A negative is anything that is not this person saying the phrase, which
  // includes other people's non-wake speech — the room this thing lives in.
  const negatives = negativeFrames.map((n) => best(n.frames, bank)).sort((a, b) => a - b);
  const ceiling = negatives[0];
  const admitted = held.filter((d) => d < ceiling).length;
  rows.push({ voice, held, negatives, ceiling, admitted });
  console.log(
    `${voice.padEnd(16)} held-out n=${String(held.length).padStart(2)} p50=${held[Math.floor(held.length / 2)].toFixed(1)} | closest negative ${ceiling.toFixed(1)} | admits ${admitted}/${held.length}`,
  );
}

const allHeld = rows.flatMap((r) => r.held).sort((a, b) => a - b);
const allCeilings = rows.map((r) => r.ceiling).sort((a, b) => a - b);
const admitted = rows.reduce((n, r) => n + r.admitted, 0);
const total = rows.reduce((n, r) => n + r.held.length, 0);
console.log(
  `\nacross ${rows.length} enrolments: ${admitted}/${total} (${((admitted / total) * 100).toFixed(0)}%) of a person's own unseen takes admitted with zero false accepts`,
);
console.log(
  `own-voice distances p50=${allHeld[Math.floor(allHeld.length / 2)].toFixed(2)} p90=${allHeld[Math.floor(allHeld.length * 0.9)].toFixed(2)}; closest-negative per voice min=${allCeilings[0].toFixed(2)} p50=${allCeilings[Math.floor(allCeilings.length / 2)].toFixed(2)}`,
);
for (const threshold of [16, 18, 20, 22, 24]) {
  const recall = allHeld.filter((d) => d <= threshold).length;
  const falseAccepts = rows.reduce((n, r) => n + r.negatives.filter((d) => d <= threshold).length, 0);
  const negTotal = rows.length * negativeFrames.length;
  console.log(
    `  threshold ${threshold}: recall ${((recall / total) * 100).toFixed(0)}% — false accepts ${falseAccepts}/${negTotal} (${((falseAccepts / negTotal) * 100).toFixed(1)}%)`,
  );
}
