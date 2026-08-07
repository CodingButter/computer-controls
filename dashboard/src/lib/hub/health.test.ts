import { describe, expect, it } from "vitest";

import { parseHealth, parseOrbStatus } from "./health";

// The fixture mirrors the live hub's answer, captured 2026-08-04 against
// /api/health on bigbeast — the shapes the fetch layer promises to hold.
const LIVE_HEALTH = {
  ok: true,
  tools: ["ask_user", "desktop_state", "view"],
  desktopScope: "observe",
  plugins: { admitted: ["desktop-control", "memorease"], refused: ["plan"] },
  model: {
    pack: "computer-controls-anthropic",
    thinking: "anthropic/claude-sonnet-4-6",
    tiers: {
      minimal: "anthropic/claude-haiku-4-5",
      standard: "anthropic/claude-sonnet-4-6",
      heavy: "anthropic/claude-opus-4-6",
    },
  },
  voice: { enabled: true },
  orb: { enabled: true },
};

describe("parseHealth", () => {
  it("reads the live hub's shape", () => {
    const health = parseHealth(LIVE_HEALTH);
    expect(health.ok).toBe(true);
    expect(health.tools).toHaveLength(3);
    expect(health.desktopScope).toBe("observe");
    expect(health.plugins.admitted).toEqual(["desktop-control", "memorease"]);
    expect(health.plugins.refused).toEqual([{ name: "plan" }]);
    expect(health.model?.pack).toBe("computer-controls-anthropic");
    expect(health.model?.tiers.heavy).toBe("anthropic/claude-opus-4-6");
    expect(health.voice).toEqual({ enabled: true });
    expect(health.orb).toEqual({ enabled: true });
  });

  it("carries a disabled capability's reason", () => {
    const health = parseHealth({
      ...LIVE_HEALTH,
      orb: { enabled: false, reason: "no realtime voice provider on this machine yet" },
    });
    expect(health.orb).toEqual({
      enabled: false,
      reason: "no realtime voice provider on this machine yet",
    });
  });

  it("reads a refusal that came with a reason, and drops one with no name", () => {
    const health = parseHealth({
      ...LIVE_HEALTH,
      plugins: {
        admitted: ["desktop-control"],
        refused: ["plan", { name: "handsy", reason: "not on the allowlist" }, { reason: "orphan" }],
      },
    });
    expect(health.plugins.refused).toEqual([
      { name: "plan" },
      { name: "handsy", reason: "not on the allowlist" },
    ]);
  });

  it("tolerates absent optional sections without inventing them", () => {
    const health = parseHealth({ ok: true });
    expect(health.tools).toEqual([]);
    expect(health.plugins).toEqual({ admitted: [], refused: [] });
    expect(health.model).toBeUndefined();
    expect(health.voice).toBeUndefined();
    expect(health.orb).toBeUndefined();
  });

  it("refuses a body that is not a health response", () => {
    expect(() => parseHealth("<html>proxy error</html>")).toThrow();
    expect(() => parseHealth(null)).toThrow();
    expect(() => parseHealth({})).toThrow();
  });
});

describe("parseOrbStatus", () => {
  it("reads the enabled shape", () => {
    const status = parseOrbStatus({ enabled: true, state: "talking", mouths: 2 });
    expect(status).toEqual({ enabled: true, state: "talking", mouths: 2 });
  });

  it("defaults a missing mouth count to zero rather than guessing", () => {
    const status = parseOrbStatus({ enabled: true, state: "idle" });
    expect(status).toEqual({ enabled: true, state: "idle", mouths: 0 });
  });

  it("reads the refused shape with its reason", () => {
    const status = parseOrbStatus({
      enabled: false,
      reason: "The orb needs a Google account. Typing still works.",
    });
    expect(status.enabled).toBe(false);
    if (!status.enabled) {
      expect(status.reason).toContain("Typing still works");
    }
  });

  it("refuses a body that is not an orb status", () => {
    expect(() => parseOrbStatus(null)).toThrow();
    expect(() => parseOrbStatus({ state: "idle" })).toThrow();
  });
});
