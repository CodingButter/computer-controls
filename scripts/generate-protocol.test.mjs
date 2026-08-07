#!/usr/bin/env node
/**
 * Regeneration must be idempotent, and the checked-in bindings must match the
 * schema. This catches a hand-edited generated file — the failure mode where
 * both halves compile, all tests pass, and the two ends have quietly diverged
 * from the contract they are supposed to share.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const generated = [
  join(root, "plugin", "src", "protocol.generated.ts"),
  join(root, "plugin", "src", "schemas.generated.ts"),
  join(root, "comcon", "desktop_service", "protocol_generated.py"),
];

const before = generated.map((path) => readFileSync(path, "utf8"));
execFileSync("node", [join(root, "scripts", "generate-protocol.mjs")], { cwd: root });
const after = generated.map((path) => readFileSync(path, "utf8"));

let failed = false;
for (const [index, path] of generated.entries()) {
  if (before[index] !== after[index]) {
    console.error(`FAIL ${path} changed on regeneration — it was edited by hand`);
    failed = true;
  } else {
    console.log(`ok   ${path.replace(root + "/", "")}`);
  }
}

// A second run must also be a no-op: a generator that alternates between two
// outputs would pass the check above on every other invocation.
execFileSync("node", [join(root, "scripts", "generate-protocol.mjs")], { cwd: root });
for (const [index, path] of generated.entries()) {
  if (readFileSync(path, "utf8") !== after[index]) {
    console.error(`FAIL ${path} is not stable across repeated generation`);
    failed = true;
  }
}

const schema = JSON.parse(readFileSync(join(root, "protocol", "schema.json"), "utf8"));
for (const [index, path] of generated.entries()) {
  if (!after[index].includes(schema.protocolVersion)) {
    console.error(`FAIL ${path} does not carry protocol version ${schema.protocolVersion}`);
    failed = true;
  }
}

console.log(failed ? "generator check FAILED" : "generator check passed");
process.exit(failed ? 1 : 0);
