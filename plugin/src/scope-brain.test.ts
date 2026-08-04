import { describe, expect, it } from "vitest";

import { brainFromGrant, selectBrain } from "./scope-brain.ts";
import { DesktopSupervisor } from "./supervisor.ts";

const observeOnly = { rank: 0, irreversible: false };
const oneApplication = { applications: 1, anchors: 0, unbounded: false };

describe("sizing the model to the scope", () => {
  it("reads one application for the price of the cheapest thing that can read", () => {
    const choice = selectBrain(observeOnly, oneApplication);
    expect(choice.tier).toBe("minimal");
  });

  it("puts the largest model behind a scope that can destroy something", () => {
    // One element, one application, and the smallest possible job. None of that
    // matters: the mistake cannot be taken back.
    const choice = selectBrain({ rank: 4, irreversible: true }, oneApplication);
    expect(choice.tier).toBe("heavy");
    expect(choice.reason).toMatch(/severity/);
  });

  it("treats submit as the cliff it is", () => {
    const choice = selectBrain({ rank: 3, irreversible: true }, oneApplication);
    expect(choice.tier).toBe("heavy");
  });

  it("escalates on breadth alone, where nothing can be broken at all", () => {
    // Forty read-only elements across a handful of applications cannot hurt
    // anybody. A small model will still lose track and report a half-finished
    // job as done, which is the other way to waste the run.
    const choice = selectBrain(observeOnly, { applications: 6, anchors: 0, unbounded: false });
    expect(choice.tier).toBe("heavy");
    expect(choice.reason).toMatch(/breadth/);
  });

  it("counts anchors towards the same spread as applications", () => {
    const choice = selectBrain(observeOnly, { applications: 1, anchors: 8, unbounded: false });
    expect(choice.tier).toBe("heavy");
    expect(choice.reason).toMatch(/anchors/);
  });

  it("treats a scope that named nothing as the widest one, not the narrowest", () => {
    // A grant with no applications named runs against every application there
    // is. Its count is a floor, and reading the floor as the total would put
    // the cheapest model behind the one scope nobody bounded.
    const choice = selectBrain(observeOnly, { applications: 0, anchors: 0, unbounded: true });
    expect(choice.tier).toBe("heavy");
    expect(choice.reason).toMatch(/every one there is/);
  });

  it("puts a middling scope in the middle", () => {
    const choice = selectBrain({ rank: 1, irreversible: false }, { applications: 2, anchors: 0, unbounded: false });
    expect(choice.tier).toBe("standard");
  });

  it("names the dimension that drove the choice", () => {
    const bySeverity = selectBrain({ rank: 3, irreversible: true }, oneApplication);
    const byBreadth = selectBrain(observeOnly, { applications: 5, anchors: 0, unbounded: false });
    expect(bySeverity.reason).toMatch(/^severity/);
    expect(byBreadth.reason).toMatch(/^breadth/);
  });
});

describe("choosing from what the service reported", () => {
  it("re-selects when a grant widens mid-run", () => {
    // The consequence that makes this worth building: a worker escalates, the
    // manager grants more, and carrying on with the cheap model is precisely
    // the wrong economy.
    const before = brainFromGrant({
      ceiling: ["observe", "edit", "submit"],
      operationClasses: ["observe"],
      severity: observeOnly,
      breadth: oneApplication,
    });
    const after = brainFromGrant({
      ceiling: ["observe", "edit", "submit"],
      operationClasses: ["observe", "submit"],
      severity: { rank: 3, irreversible: true },
      breadth: { applications: 2, anchors: 0, unbounded: false },
    });

    expect(before.tier).toBe("minimal");
    expect(after.tier).toBe("heavy");
  });

  it("does not assume a service that cannot say is a small job", () => {
    // An unknown scope is not a safe scope. Guessing downwards here would put
    // the cheapest model behind the one grant nobody could measure.
    const choice = brainFromGrant({ ceiling: ["observe"], operationClasses: ["observe"] });
    expect(choice.tier).toBe("heavy");
    expect(choice.reason).toMatch(/does not report/);
  });
});

describe("where the choice now lives", () => {
  // A13 removed granting from the agent's hand, so there is no tool whose
  // answer could carry a tier. The grant response exists in exactly one place:
  // the supervisor's door opening. That is where the choice is made, and the
  // host reads it from the supervisor rather than from a tool output.
  it("exposes no choice before a door has been opened", () => {
    const fresh = new DesktopSupervisor("scope-brain-test");
    expect(fresh.brain).toBeUndefined();
  });

  it("only ever answers with a tier a host can map", () => {
    // The old tool schema enforced the enum at the protocol edge; without the
    // tool, the guarantee is that the selector cannot produce anything else.
    const tiers = new Set(["minimal", "standard", "heavy"]);
    for (const rank of [0, 1, 2, 3, 4]) {
      for (const applications of [0, 1, 3, 6]) {
        const choice = selectBrain(
          { rank, irreversible: rank >= 3 },
          { applications, anchors: 0, unbounded: applications === 0 },
        );
        expect(tiers.has(choice.tier)).toBe(true);
        expect(choice.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("counts anchored places in what the service reported", () => {
    // A15 shipped: an anchored grant is not narrow just because it names one
    // application. Eight anchored fields are eight things to keep track of.
    const choice = brainFromGrant({
      ceiling: ["observe", "edit"],
      operationClasses: ["observe", "edit"],
      severity: { rank: 1, irreversible: false },
      breadth: { applications: 1, anchors: 8, unbounded: false },
    });
    expect(choice.tier).toBe("heavy");
    expect(choice.reason).toMatch(/anchors/);
  });
});
