#!/usr/bin/env node
/**
 * Vendor the ear's heavy assets: the transformers runtime, the ONNX WASM, and
 * the Moonshine tiny English weights.
 *
 * These are deliberately NOT committed (src/vendor/ear/ is gitignored): the
 * working set is ~80 MB of model and WASM, which would fatten the repository
 * forever for files that two commands reproduce exactly. The runtime and WASM
 * come from node_modules (pnpm install already fetched them); the model
 * weights are downloaded from Hugging Face HERE, at vendor time, so the
 * network hit happens on a build machine and never on a user's machine at
 * first run. The renderer pins `allowRemoteModels = false` — a widget that
 * is missing these files has no ear, not a phone line.
 *
 * dtype q4 is not a preference: the q8 quantized decoder fails session
 * creation on onnxruntime-web 1.26 (TransposeDQWeightsForMatMulNBits missing
 * scale), proven in the segment-05 spike. The English-only model is the
 * licence seam from live/ear.ts: Moonshine English is MIT, multilingual is
 * non-commercial and cannot ship.
 *
 * Idempotent: files already present at the right size are not re-fetched.
 */
import { createWriteStream, existsSync, mkdirSync, copyFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const widgetRoot = join(here, "..");

const earDir = join(widgetRoot, "src", "vendor", "ear");
const libDir = join(earDir, "lib");
const MODEL_ID = "onnx-community/moonshine-tiny-ONNX";
const modelDir = join(earDir, "model", MODEL_ID);

mkdirSync(libDir, { recursive: true });
mkdirSync(join(modelDir, "onnx"), { recursive: true });

// --- The runtime and WASM, from node_modules ---
// transformers.min.js rather than transformers.web.min.js: the web build
// carries a bare "onnxruntime-web/webgpu" specifier that cannot resolve
// without a bundler or import map, and this repo deliberately has neither.
const transformersDist = join(widgetRoot, "node_modules", "@huggingface", "transformers", "dist");
// onnxruntime-web is transformers' dependency, not the widget's, so it is
// resolved from inside the transformers package rather than from here.
// realpath first: pnpm symlinks the package, and require's lookup-path chain
// is computed from the literal path — the real one is where the deps live.
const require = createRequire(join(realpathSync(transformersDist), "index.js"));
// Resolve the package entry (its exports map hides package.json) and walk to dist/.
const ortEntry = require.resolve("onnxruntime-web");
const ortDist = join(ortEntry.slice(0, ortEntry.lastIndexOf("/onnxruntime-web/") + "/onnxruntime-web".length + 1), "dist");

const copies = [
  [join(transformersDist, "transformers.min.js"), join(libDir, "transformers.min.js")],
  // ort resolves the asyncify variant on this path; the transformers dist
  // ships only the jsep one, so both loader and binary come from ort's dist.
  [join(ortDist, "ort-wasm-simd-threaded.asyncify.mjs"), join(libDir, "ort-wasm-simd-threaded.asyncify.mjs")],
  [join(ortDist, "ort-wasm-simd-threaded.asyncify.wasm"), join(libDir, "ort-wasm-simd-threaded.asyncify.wasm")],
];

for (const [from, to] of copies) {
  copyFileSync(from, to);
  console.log(`vendored ${to.replace(widgetRoot + "/", "")}`);
}

// --- The model weights, from Hugging Face ---
const HF = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const files = [
  "config.json",
  "generation_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "preprocessor_config.json",
  "onnx/encoder_model_q4.onnx",
  "onnx/decoder_model_merged_q4.onnx",
];

for (const name of files) {
  const to = join(modelDir, name);
  if (existsSync(to) && statSync(to).size > 0) {
    console.log(`present ${to.replace(widgetRoot + "/", "")}`);
    continue;
  }
  const response = await fetch(`${HF}/${name}`);
  if (!response.ok) {
    throw new Error(`fetching ${name}: ${response.status} ${response.statusText}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(to));
  console.log(`fetched ${to.replace(widgetRoot + "/", "")} (${statSync(to).size} bytes)`);
}
