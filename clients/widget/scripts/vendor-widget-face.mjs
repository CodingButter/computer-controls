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
 * cosmetic: boundaries.test.ts scans only the top level of src/ (a flat
 * readdirSync), and three.module.js carries dead audio-path substrings the
 * widget never invokes. Keeping the copy in a subdirectory is what lets the
 * per-file audio allowlist hold while the face still ships as a local 'self'
 * file under the widget's CSP.
 */
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const widgetRoot = join(here, "..");
const repoRoot = join(widgetRoot, "..", "..");

const faceDir = join(widgetRoot, "src", "face");
const vendorDir = join(faceDir, "vendor");
const liveDir = join(widgetRoot, "src", "vendor", "live");

mkdirSync(vendorDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const sources = [
  [join(repoRoot, "client", "public", "orb-webgl.js"), join(faceDir, "orb-webgl.js")],
  [join(repoRoot, "client", "public", "vendor", "three.module.js"), join(vendorDir, "three.module.js")],
  // The capture worklet is shared with the orb page the same way the face is:
  // one canonical home, one committed copy, one parity test.
  [
    join(repoRoot, "client", "public", "orb-capture-worklet.js"),
    join(widgetRoot, "src", "vendor", "orb-capture-worklet.js"),
  ],
];

// The shared live module travels as a WHOLE DIRECTORY: the files import each
// other by relative specifier, and copying the directory intact is what keeps
// those specifiers true. Cherry-picking files here would be the quiet way to
// ship a module that resolves differently than the one the hub tests.
const hubLive = join(repoRoot, "client", "public", "live");
for (const name of readdirSync(hubLive)) {
  sources.push([join(hubLive, name), join(liveDir, name)]);
}

for (const [from, to] of sources) {
  copyFileSync(from, to);
  console.log(`vendored ${from.replace(repoRoot + "/", "")} -> ${to.replace(widgetRoot + "/", "")}`);
}
