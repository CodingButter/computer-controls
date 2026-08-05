import { readFileSync } from "node:fs";
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
] as const;

describe("the widget's face is the hub's face, byte for byte", () => {
  test.each(pairs)("%s has not diverged from the canonical source", (hubRel, widgetRel) => {
    const hubFile = readFileSync(new URL(hubRel, hubPublic), "utf8");
    const widgetFile = readFileSync(new URL(widgetRel, widgetSrc), "utf8");
    expect(widgetFile, `${widgetRel} must be re-vendored (run scripts/vendor-widget-face.mjs)`).toBe(hubFile);
  });
});
