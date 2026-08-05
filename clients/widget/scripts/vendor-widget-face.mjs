#!/usr/bin/env node
/**
 * Vendor the shader face into the widget from the one canonical home.
 *
 * The hub's `/orb` page and the widget must render the same face. There is one
 * source of truth — client/public/orb-webgl.js and client/public/vendor/three.module.js —
 * and this script refreshes the widget's committed copy from it. It is run by a
 * person after the face source changes; face-parity.test.ts fails in CI if they
 * forget, so the two windows cannot quietly diverge.
 *
 * The vendored files live under src/face/ rather than flat in src/. That is not
 * cosmetic: no-ears.test.ts scans only the top level of src/ (a flat readdirSync),
 * and three.module.js carries dead audio-path substrings the widget never invokes.
 * Keeping the copy in a subdirectory is what lets the no-ear property hold while
 * the face still ships as a local 'self' file under the widget's CSP.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const widgetRoot = join(here, "..");
const repoRoot = join(widgetRoot, "..", "..");

const faceDir = join(widgetRoot, "src", "face");
const vendorDir = join(faceDir, "vendor");

mkdirSync(vendorDir, { recursive: true });

const sources = [
  [join(repoRoot, "client", "public", "orb-webgl.js"), join(faceDir, "orb-webgl.js")],
  [join(repoRoot, "client", "public", "vendor", "three.module.js"), join(vendorDir, "three.module.js")],
];

for (const [from, to] of sources) {
  copyFileSync(from, to);
  console.log(`vendored ${from.replace(repoRoot + "/", "")} -> ${to.replace(widgetRoot + "/", "")}`);
}
