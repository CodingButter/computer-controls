import { describe, expect, it } from "vitest";

import plugin from "./index.ts";
import { brainFromGrant, selectBrain } from "./scope-brain.ts";

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

describe("the grant tool's answer", () => {
  const tools = plugin.tools as Record<string, { tool: { outputSchema: any } }>;

  it("carries the tier alongside what was granted", () => {
    const schema = tools.desktop_grant_scope!.tool.outputSchema;
    const answer = {
      ceiling: ["observe", "submit"],
      operationClasses: ["observe", "submit"],
      severity: { rank: 3, irreversible: true },
      breadth: { applications: 1, anchors: 0, unbounded: false },
      brain: { tier: "heavy", reason: "severity: irreversible" },
    };
    expect(schema.safeParse(answer).success).toBe(true);
  });

  it("will not accept a tier it does not know", () => {
    const schema = tools.desktop_grant_scope!.tool.outputSchema;
    const answer = {
      ceiling: ["observe"],
      operationClasses: ["observe"],
      brain: { tier: "gpt-9", reason: "made up" },
    };
    expect(schema.safeParse(answer).success).toBe(false);
  });
});
