import { describe, expect, test } from "vitest";

import { shaderStateFor } from "./face-state.js";
import { hasWebGl } from "./face/orb-webgl.js";
import { INITIAL_STATE, reduce } from "./state-machine.js";

/**
 * The shader face is driven by the same vocabulary as the CSS face.
 *
 * These are the two pure halves the renderer's mount depends on: the mapping
 * from the widget's state to the shader's face state, and the WebGL probe that
 * decides shader-orb vs. CSS-orb. Neither touches a document or a GPU — the
 * mapping is arithmetic on a plain object, and the probe is fed a stub whose
 * getContext returns null. A full shader render is a visual check, not a unit
 * test; what is provable here is that every real transition reaches the right
 * face state, and that a machine without WebGL takes the fallback path rather
 * than throwing.
 */

describe("shaderStateFor", () => {
  test("a hidden widget is idle", () => {
    expect(shaderStateFor({ presence: "hidden", activity: "listening" })).toBe("idle");
    expect(shaderStateFor({ presence: "hidden", activity: "speaking" })).toBe("idle");
  });

  test("a visible widget's activity is the face state", () => {
    expect(shaderStateFor({ presence: "visible", activity: "listening" })).toBe("listening");
    expect(shaderStateFor({ presence: "visible", activity: "thinking" })).toBe("thinking");
    expect(shaderStateFor({ presence: "visible", activity: "speaking" })).toBe("speaking");
  });

  test("every transition the reducer can produce maps to a shader state", () => {
    const events = [
      { type: "wake_opened" },
      { type: "caption", text: "hello" },
      { type: "thinking" },
      { type: "speaking" },
      { type: "idle" },
    ];
    let state = INITIAL_STATE;
    // The initial state maps cleanly.
    expect(shaderStateFor(state)).toBe("idle");
    for (const event of events) {
      state = reduce(state, event);
      const face = shaderStateFor(state);
      expect(face, `${event.type} → ${JSON.stringify(state)}`).toMatch(
        /^(idle|listening|thinking|speaking)$/,
      );
    }
  });
});

describe("hasWebGl", () => {
  test("returns false, not null or a throw, when WebGL is unavailable", () => {
    const noGl = { getContext: () => null };
    expect(hasWebGl(noGl)).toBe(false);

    const throws = { getContext: () => { throw new Error("no WebGL"); } };
    expect(hasWebGl(throws)).toBe(false);
  });
});
