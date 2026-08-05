import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * The live module runs in browsers, and this test is what keeps that true.
 *
 * The import ban is the obvious half: nothing under src/live/ may import
 * `node:*`, `ws`, or reach back up into the hub (`../`), because any of those
 * turns a browser-safe module into a hub-only one the moment it lands. The
 * subtler half is globals — `Buffer` and `process` need no import to compile
 * under the hub's tsconfig, which is exactly how they'd sneak in. (They did:
 * the first browser compile of this module found Buffer in four places.)
 * tsconfig.live.json compiles with an empty `types` list, so the asset-parity
 * test already fails on Node globals; the source scan here names the offender
 * in the failure instead of leaving a compiler error to be puzzled out.
 *
 * Test files are exempt: they run under vitest on Node, and their use of
 * node:fs is how these two tests exist at all.
 */

const liveDir = path.dirname(fileURLToPath(import.meta.url));
const shipped = readdirSync(liveDir).filter(
  (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
);

const BANNED_IMPORTS = /^import[^\n]*from\s+["'](node:|ws["']|\.\.\/)/m;
const BANNED_GLOBALS = /\b(?:Buffer|process|require|__dirname|__filename)\b/;

describe("the live module stays browser-safe", () => {
  test("there are shipped files to check", () => {
    expect(shipped.length).toBeGreaterThan(0);
  });

  test.each(shipped)("%s imports nothing a browser cannot follow", (name) => {
    const text = readFileSync(path.join(liveDir, name), "utf8");
    expect(text).not.toMatch(BANNED_IMPORTS);
  });

  test.each(shipped)("%s leans on no Node global", (name) => {
    const text = readFileSync(path.join(liveDir, name), "utf8");
    for (const line of text.split("\n")) {
      // Comments may name Buffer while explaining why it is banned.
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      expect(code, `${name}: ${line.trim()}`).not.toMatch(BANNED_GLOBALS);
    }
  });
});
