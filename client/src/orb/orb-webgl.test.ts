import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The WebGL module's pure seams, imported exactly as the browser loads them.
// three.js is never resolved here — mountWebGlOrb is async and dynamic, and
// these tests exercise the functions above it that are DOM-free and
// three.js-free on purpose.
import {
  ORB_STATES,
  levelToDisplacement,
  stateToParams,
  moodToColor,
  hasWebGl,
  syntheticLevel,
} from "../../public/orb-webgl.js";

// ---------------------------------------------------------------------------
// Acceptance test 1: the orb module mounts on a canvas and consumes state events.
// The mount itself needs WebGL (tested separately); here we verify the module
// recognizes every hub state and produces distinct shader parameters for each.
// ---------------------------------------------------------------------------

describe("test_the_orb_module_mounts_on_a_canvas_and_consumes_state_events", () => {
  it("names the same closed state set as the DOM orb", () => {
    expect(ORB_STATES).toEqual(["idle", "listening", "thinking", "speaking"]);
  });

  it("produces shader parameters for each known state", () => {
    for (const state of ORB_STATES) {
      const p = stateToParams(state);
      expect(p).toBeDefined();
      expect(typeof p.noiseSpeed).toBe("number");
      expect(typeof p.noiseScale).toBe("number");
      expect(typeof p.pulseFreq).toBe("number");
    }
  });

  it("gives each state a distinct motion signature", () => {
    const sigs = ORB_STATES.map(
      (s) => `${stateToParams(s).noiseSpeed}:${stateToParams(s).noiseScale}:${stateToParams(s).pulseFreq}`,
    );
    expect(new Set(sigs).size).toBe(ORB_STATES.length);
  });

  it("falls back to idle for an unknown state rather than guessing", () => {
    expect(stateToParams("exploding")).toEqual(stateToParams("idle"));
    expect(stateToParams(undefined)).toEqual(stateToParams("idle"));
  });
});

// ---------------------------------------------------------------------------
// Acceptance test 2: audio level drives the shader displacement uniform.
// setLevel is module-internal — the page synthesizes a level from state and
// feeds it in. Here we verify the level→displacement mapping is monotonic and
// that the synthetic level source produces changing values.
// ---------------------------------------------------------------------------

describe("test_audio_level_drives_the_shader_displacement_uniform", () => {
  it("is monotonically increasing across the full range", () => {
    const d0 = levelToDisplacement(0);
    const d5 = levelToDisplacement(0.5);
    const d1 = levelToDisplacement(1.0);
    expect(d0).toBeLessThan(d5);
    expect(d5).toBeLessThan(d1);
  });

  it("never goes dead-flat — idle has a floor", () => {
    expect(levelToDisplacement(0)).toBeGreaterThan(0);
  });

  it("clamps out-of-range values without throwing", () => {
    expect(() => levelToDisplacement(-5)).not.toThrow();
    expect(() => levelToDisplacement(42)).not.toThrow();
    expect(levelToDisplacement(-5)).toBe(levelToDisplacement(0));
    expect(levelToDisplacement(42)).toBe(levelToDisplacement(1));
  });

  it("produces a synthetic level that varies with time for speaking", () => {
    const a = syntheticLevel("speaking", 0);
    const b = syntheticLevel("speaking", 200);
    expect(a).not.toBe(b);
  });

  it("produces zero for idle — the quietest state", () => {
    expect(syntheticLevel("idle", 0)).toBe(0);
    expect(syntheticLevel("idle", 1000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Acceptance test 4: a browser without WebGL falls back to the DOM orb.
// hasWebGl is the gate the page uses; here we verify it returns false for
// every failure mode a browser can present.
// ---------------------------------------------------------------------------

describe("test_a_browser_without_webgl_falls_back_to_the_dom_orb", () => {
  it("returns false when no WebGL context exists", () => {
    expect(hasWebGl({ getContext: () => null })).toBe(false);
  });

  it("returns true when a WebGL context is available", () => {
    expect(hasWebGl({ getContext: () => ({}) })).toBe(true);
  });

  it("does not throw when getContext itself throws", () => {
    expect(
      hasWebGl({
        getContext: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(false);
  });

  it("checks webgl first, then experimental-webgl", () => {
    const calls: string[] = [];
    hasWebGl({
      getContext: (type: string) => {
        calls.push(type);
        return null;
      },
    });
    expect(calls).toEqual(["webgl", "experimental-webgl"]);
  });
});

// ---------------------------------------------------------------------------
// Mood color: a uniform, tweened over time (#106). Verified here so the
// mapping is locked before #106 starts sending labels.
// ---------------------------------------------------------------------------

describe("mood color mapping", () => {
  it("returns a valid RGB triplet for neutral", () => {
    const [r, g, b] = moodToColor("neutral");
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(g).toBeLessThanOrEqual(1);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(1);
  });

  it("maps frustration toward red", () => {
    const [r] = moodToColor("frustrated");
    expect(r).toBeGreaterThan(0.7);
  });

  it("falls back to neutral for an unknown mood", () => {
    expect(moodToColor("confused")).toEqual(moodToColor("neutral"));
  });
});

// ---------------------------------------------------------------------------
// Acceptance test 3: the vendored three module is served by the hub and named
// in the import map. readUiAsset serves /vendor/three.module.js from
// public/vendor/ with zero code change — this test verifies the file exists on
// disk and that orb.html's import map resolves "three" to that path.
// ---------------------------------------------------------------------------

describe("test_the_vendored_three_module_is_served_by_the_hub_and_named_in_the_import_map", () => {
  const publicDir = resolve(__dirname, "../../public");

  it("places three.module.js under public/vendor/", () => {
    const threePath = resolve(publicDir, "vendor/three.module.js");
    const content = readFileSync(threePath, "utf-8");
    expect(content.length).toBeGreaterThan(10000); // real build, not a stub
  });

  it("maps \"three\" to /vendor/three.module.js in orb.html's import map", () => {
    const html = readFileSync(resolve(publicDir, "orb.html"), "utf-8");
    const match = html.match(/<script[^>]*type="importmap"[^>]*>([\s\S]*?)<\/script>/);
    expect(match, "orb.html must contain a type=importmap script").not.toBeNull();
    const map = JSON.parse(match![1].trim());
    expect(map.imports.three).toBe("/vendor/three.module.js");
  });
});

// ---------------------------------------------------------------------------
// Acceptance test 5: the page ships no bundler and no runtime CDN fetch.
// three.js is vendored as a local file; the import map resolves it locally;
// no script or module ever fetches from a CDN at runtime.
// ---------------------------------------------------------------------------

describe("test_the_page_ships_no_bundler_and_no_runtime_cdn_fetch", () => {
  const publicDir = resolve(__dirname, "../../public");

  const CDN_PATTERNS = [
    /unpkg\.com/i,
    /jsdelivr\.net/i,
    /esm\.sh/i,
    /skypack\.dev/i,
    /cdn\.jsdelivr/i,
  ];

  it("has no CDN URLs in orb.html or orb-webgl.js", () => {
    const html = readFileSync(resolve(publicDir, "orb.html"), "utf-8");
    const webgl = readFileSync(resolve(publicDir, "orb-webgl.js"), "utf-8");
    for (const pattern of CDN_PATTERNS) {
      expect(html).not.toMatch(pattern);
      expect(webgl).not.toMatch(pattern);
    }
  });

  it("imports three from the bare specifier \"three\", resolved by the import map", () => {
    const webgl = readFileSync(resolve(publicDir, "orb-webgl.js"), "utf-8");
    expect(webgl).toMatch(/import\("three"\)/);
    expect(webgl).not.toMatch(/https?:\/\//); // no absolute URL imports
  });
});
