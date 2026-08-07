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
  smokeChurn,
  calmScale,
  desaturate,
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

  it("asks for webgl2, the context three r169 actually requires", () => {
    const calls: string[] = [];
    hasWebGl({
      getContext: (type: string) => {
        calls.push(type);
        return null;
      },
    });
    expect(calls).toEqual(["webgl2"]);
  });

  it("probes a scratch canvas, never the display canvas", () => {
    // A canvas remembers its first context type; probing the display canvas
    // blocks three.js from creating its own context on it later.
    const orbJs = readFileSync(resolve(__dirname, "../../public/orb.js"), "utf-8");
    expect(orbJs).toMatch(/hasWebGl\(document\.createElement\("canvas"\)\)/);
    expect(orbJs).not.toMatch(/hasWebGl\(canvas\)/);
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
// #202: the face says who is talking. The outer smoke is the user's layer and
// the inner sphere is the orb's, so the two must be drivable independently —
// and muted has to look like a third thing, not like a quiet room.
// ---------------------------------------------------------------------------

describe("test_the_face_shows_who_is_talking", () => {
  it("churns the smoke harder the louder the user speaks", () => {
    expect(smokeChurn(0)).toBeLessThan(smokeChurn(0.5));
    expect(smokeChurn(0.5)).toBeLessThan(smokeChurn(1));
  });

  it("keeps the smoke drifting at silence — still is not frozen", () => {
    expect(smokeChurn(0)).toBeGreaterThan(0);
  });

  it("clamps a level outside the range instead of flinging the haze", () => {
    expect(smokeChurn(-3)).toBe(smokeChurn(0));
    expect(smokeChurn(9)).toBe(smokeChurn(1));
  });

  it("lets the voice dominate the drift floor, so speech is the visible part", () => {
    // The swing the voice adds must be larger than the resting drift, or
    // "the smoke moved" would be indistinguishable from the idle churn.
    expect(smokeChurn(1) - smokeChurn(0)).toBeGreaterThan(smokeChurn(0));
  });

  it("slows the whole face when muted, without freezing it", () => {
    expect(calmScale(true)).toBeLessThan(calmScale(false));
    expect(calmScale(true)).toBeGreaterThan(0);
  });

  it("drains colour toward grey when muted, and is the identity when not", () => {
    const mood = moodToColor("frustrated");
    const drained = desaturate(mood, 0.7);
    const spread = (c: number[]) => Math.max(...c) - Math.min(...c);
    expect(spread(drained)).toBeLessThan(spread(mood));
    expect(desaturate(mood, 0)).toEqual(mood);
  });

  it("collapses to a single grey at full desaturation", () => {
    const [r, g, b] = desaturate(moodToColor("excited"), 1);
    expect(g - r).toBeCloseTo(0, 5);
    expect(b - r).toBeCloseTo(0, 5);
  });

  it("gives the smoke its own flow clock and level uniforms", () => {
    // The two layers shared uFlowTime and one uLevel before #202 — the whole
    // face moved on one clock, so it could not say who was talking.
    const webgl = readFileSync(resolve(__dirname, "../../public/orb-webgl.js"), "utf-8");
    const smokeShader = webgl.slice(webgl.indexOf("SMOKE_FRAGMENT_SHADER"));
    expect(smokeShader).toMatch(/uniform float uSmokeFlowTime;/);
    expect(smokeShader).toMatch(/uniform float uSmokeLevel;/);
    expect(smokeShader).toMatch(/uniform float uDim;/);
  });

  it("exposes the user level and the mute state on the controller", () => {
    const webgl = readFileSync(resolve(__dirname, "../../public/orb-webgl.js"), "utf-8");
    expect(webgl).toMatch(/return \{[^}]*setUserLevel[^}]*setMuted[^}]*\}/);
  });
});

// ---------------------------------------------------------------------------
// Acceptance test 3: the vendored three module is served by the hub and
// reached by a relative import. readUiAsset serves /vendor/three.module.js
// from public/vendor/ with zero code change — this test verifies the file
// exists on disk and that no page carries an import map for it. Import maps
// are how the widget's face silently broke: its page loaded the map from an
// external file, which Chromium ignores, and the shader never mounted.
// ---------------------------------------------------------------------------

describe("test_the_vendored_three_module_is_served_by_the_hub_and_reached_relatively", () => {
  const publicDir = resolve(__dirname, "../../public");

  it("places three.module.js under public/vendor/", () => {
    const threePath = resolve(publicDir, "vendor/three.module.js");
    const content = readFileSync(threePath, "utf-8");
    expect(content.length).toBeGreaterThan(10000); // real build, not a stub
  });

  it("carries no import map in orb.html — the relative import made it dead weight", () => {
    const html = readFileSync(resolve(publicDir, "orb.html"), "utf-8");
    expect(html).not.toMatch(/type="importmap"/);
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

  it("imports three by relative path — the one spelling that works on every page that wears this face", () => {
    const webgl = readFileSync(resolve(publicDir, "orb-webgl.js"), "utf-8");
    expect(webgl).toMatch(/import\("\.\/vendor\/three\.module\.js"\)/);
    expect(webgl).not.toMatch(/import\("three"\)/);
    expect(webgl).not.toMatch(/https?:\/\//); // no absolute URL imports
  });
});
