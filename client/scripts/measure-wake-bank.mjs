#!/usr/bin/env node
/**
 * Measure the factory bank against audio it has never seen.
 *
 * The bank is only worth shipping if it separates two things: takes of "hey
 * mastra" it was not built from, and speech that is not the wake phrase at all.
 * This prints both distributions and the threshold that would sit between them,
 * so the number in fingerprint.ts is a measurement rather than a guess.
 *
 * It asserts nothing. A threshold is a product decision — how often the orb may
 * wake by accident against how often it may miss you — and this only supplies
 * the arithmetic that decision needs.
 *
 *   node scripts/measure-wake-bank.mjs <positives-dir> <negatives-dir>
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mfcc, subsequenceDtw } from "../public/live/fingerprint.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bank = JSON.parse(readFileSync(path.resolve(here, "../src/wake/factory-bank.json"), "utf8"));

function decodeWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF") throw new Error("not RIFF");
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

/** The gate's own arithmetic: the closest template wins, and that distance is the verdict. */
function bestDistance(file) {
  const { samples, sampleRate } = decodeWav(readFileSync(file));
  const frames = mfcc(samples, sampleRate);
  let best = Infinity;
  for (const template of bank.templates) {
    const distance = subsequenceDtw(frames, template.frames);
    if (distance < best) best = distance;
  }
  return best;
}

function scoreDir(dir, skip = () => false) {
  const scores = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".wav")).sort()) {
    if (skip(file)) continue;
    try {
      scores.push({ file, distance: bestDistance(path.join(dir, file)) });
    } catch {
      // A clip this decoder refuses is a clip the product would refuse too.
    }
  }
  return scores.sort((a, b) => a.distance - b.distance);
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

const [positivesDir, negativesDir] = process.argv.slice(2);
if (!positivesDir || !negativesDir) {
  console.error("usage: measure-wake-bank.mjs <positives-dir> <negatives-dir>");
  process.exit(2);
}

// A template's own clip scoring zero proves nothing, so held-out means held out.
const inBank = new Set(bank.templates.map((t) => `${t.id.slice("factory-".length)}.wav`));
const positives = scoreDir(positivesDir, (f) => inBank.has(f));
const negatives = scoreDir(negativesDir);

const pd = positives.map((p) => p.distance);
const nd = negatives.map((n) => n.distance);
console.log(`bank: ${bank.templates.length} templates`);
console.log(
  `held-out positives: n=${pd.length} min=${pd[0]?.toFixed(3)} p50=${quantile(pd, 0.5)?.toFixed(3)} p90=${quantile(pd, 0.9)?.toFixed(3)} max=${pd.at(-1)?.toFixed(3)}`,
);
console.log(
  `negatives:          n=${nd.length} min=${nd[0]?.toFixed(3)} p10=${quantile(nd, 0.1)?.toFixed(3)} p50=${quantile(nd, 0.5)?.toFixed(3)}`,
);

// The operating point: the highest threshold that admits no negative at all,
// and what fraction of unseen positives it lets through.
const ceiling = nd[0] ?? Infinity;
const admitted = pd.filter((d) => d < ceiling).length;
console.log(
  `\nno-false-accept ceiling: ${Number.isFinite(ceiling) ? ceiling.toFixed(3) : "none"} — admits ${admitted}/${pd.length} unseen positives (${((admitted / Math.max(1, pd.length)) * 100).toFixed(0)}%)`,
);
for (const step of [0.5, 0.75, 0.9, 0.95]) {
  const threshold = quantile(pd, step);
  const falseAccepts = nd.filter((d) => d <= threshold).length;
  console.log(
    `  threshold ${threshold?.toFixed(3)} (${(step * 100).toFixed(0)}% recall): ${falseAccepts} false accept(s)`,
  );
}
console.log(`\nworst held-out positives: ${positives.slice(-3).map((p) => `${p.file} ${p.distance.toFixed(2)}`).join(", ")}`);
console.log(`closest negatives: ${negatives.slice(0, 3).map((n) => `${n.file} ${n.distance.toFixed(2)}`).join(", ")}`);
