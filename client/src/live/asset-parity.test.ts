import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * One protocol, one home.
 *
 * The browser mouth imports /live/session.js; the hub compiles
 * src/live/session.ts. The emitted files under public/live/ are committed
 * (the hub serves them statically, with no build step at runtime), so the
 * one way they could lie is by going stale against the source. This test
 * regenerates into a temp directory and diffs byte-for-byte — the page and
 * the hub can never quietly run different protocols.
 *
 * Re-emit with: node scripts/generate-live-assets.mjs
 */

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const committedDir = path.join(clientRoot, "public", "live");
const freshDir = mkdtempSync(path.join(os.tmpdir(), "comcon-live-assets-"));

afterAll(() => {
  rmSync(freshDir, { recursive: true, force: true });
});

describe("the served live module is the compiled live module, byte for byte", () => {
  execFileSync("node", [path.join(clientRoot, "scripts", "generate-live-assets.mjs"), freshDir], {
    cwd: clientRoot,
  });
  const fresh = readdirSync(freshDir).filter((name) => name.endsWith(".js")).sort();

  test("the same set of files exists in both places", () => {
    const committed = readdirSync(committedDir).filter((name) => name.endsWith(".js")).sort();
    expect(committed).toEqual(fresh);
    expect(fresh.length).toBeGreaterThan(0);
  });

  test.each(fresh)("%s has not gone stale (run scripts/generate-live-assets.mjs)", (name) => {
    const committed = readFileSync(path.join(committedDir, name), "utf8");
    const regenerated = readFileSync(path.join(freshDir, name), "utf8");
    expect(committed).toBe(regenerated);
  });
});
