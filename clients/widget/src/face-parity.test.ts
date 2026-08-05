import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * One face, one home.
 *
 * The hub's `/orb` page and the widget render the same shader face, and the
 * source of truth is the hub's copy: client/public/orb-webgl.js and the vendored
 * three.module.js beside it. The widget ships a committed copy so it can run
 * from a file:// origin with no bundler and no fetch, but the copy must stay
 * byte-identical to the home. This test fails the moment they diverge — which is
 * exactly the failure copy-paste would let through and the issue rejects.
 *
 * Re-vendor with: node scripts/vendor-widget-face.mjs
 */

const widgetSrc = new URL(".", import.meta.url);

// From clients/widget/src/ up to repo root, then into client/public.
const hubPublic = new URL("../../../client/public/", import.meta.url);

const pairs = [
  ["orb-webgl.js", "face/orb-webgl.js"],
  ["vendor/three.module.js", "face/vendor/three.module.js"],
  ["orb-capture-worklet.js", "vendor/orb-capture-worklet.js"],
] as const;

describe("the widget's face is the hub's face, byte for byte", () => {
  test.each(pairs)("%s has not diverged from the canonical source", (hubRel, widgetRel) => {
    const hubFile = readFileSync(new URL(hubRel, hubPublic), "utf8");
    const widgetFile = readFileSync(new URL(widgetRel, widgetSrc), "utf8");
    expect(widgetFile, `${widgetRel} must be re-vendored (run scripts/vendor-widget-face.mjs)`).toBe(hubFile);
  });
});

describe("the widget's live module is the hub's live module, byte for byte", () => {
  // The whole directory, both directions: a file added at the canonical home
  // must arrive here, and a file lingering here that the home deleted is a
  // module the hub no longer tests. Cheaper than trusting the copy step.
  const hubLive = new URL("live/", hubPublic);
  const widgetLive = new URL("vendor/live/", widgetSrc);

  test("the directories hold the same files", () => {
    const hubFiles = readdirSync(hubLive).sort();
    expect(hubFiles.length, "the canonical live module must not be empty").toBeGreaterThan(0);
    expect(readdirSync(widgetLive).sort()).toEqual(hubFiles);
  });

  test("every file matches its canonical source", () => {
    for (const name of readdirSync(hubLive)) {
      const hubFile = readFileSync(new URL(name, hubLive), "utf8");
      const widgetFile = readFileSync(new URL(name, widgetLive), "utf8");
      expect(widgetFile, `vendor/live/${name} must be re-vendored (run scripts/vendor-widget-face.mjs)`).toBe(hubFile);
    }
  });
});
