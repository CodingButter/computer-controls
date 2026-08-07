import { describe, expect, it } from "vitest";

import { DesktopSignalProvider, priorityOf, summarize } from "./desktop-signal-provider.ts";
import type { DeltaLike, DesktopSource } from "./desktop-signal-provider.ts";

function delta(partial: Partial<DeltaLike>): DeltaLike {
  return { changes: [], revision: 0, complete: true, ...partial };
}

function change(kind: string, summary: string, attribution?: string) {
  return { kind, summary, revision: 1, attribution };
}

/** A desktop that answers from a script, so the lane can be tested without one. */
class ScriptedDesktop implements DesktopSource {
  asked: Array<number> = [];
  readonly startRevision: number;
  readonly answers: Array<DeltaLike>;
  constructor(startRevision: number, answers: Array<DeltaLike>) {
    this.startRevision = startRevision;
    this.answers = answers;
  }
  async revision(): Promise<number> {
    return this.startRevision;
  }
  async since(revision: number): Promise<DeltaLike> {
    this.asked.push(revision);
    return this.answers.shift() ?? delta({ revision });
  }
}

type Sent = { threadId: string; priority: string; summary: string };

function providerOver(source: DesktopSource) {
  const sent: Array<Sent> = [];
  const provider = new DesktopSignalProvider({
    source,
    onSent: (target, priority, summary) => sent.push({ threadId: target.threadId, priority, summary }),
  });
  // The base class's notify needs a connected agent; this lane only cares that
  // a send was attempted, so it is replaced wholesale.
  (provider as unknown as { notify: () => Promise<void> }).notify = async () => {};
  return { provider, sent };
}

const TARGET = { threadId: "t1", resourceId: "r1" };

describe("priority", () => {
  it("treats ordinary news as ambient", () => {
    expect(priorityOf([change("focus-changed", "focus moved")])).toBe("medium");
  });

  it("treats a window disappearing as an interrupt", () => {
    expect(priorityOf([change("window-opened", "a"), change("window-closed", "b")])).toBe("high");
  });

  it("treats a human touching something as an interrupt whatever the kind", () => {
    expect(priorityOf([change("element-value-changed", "typed", "user")])).toBe("high");
  });

  it("never returns low, which the runtime would turn into a wake", () => {
    const kinds = ["focus-changed", "window-opened", "element-value-changed", "element-stale"];
    for (const kind of kinds) {
      expect(["medium", "high"]).toContain(priorityOf([change(kind, "x")]));
    }
  });
});

describe("what the model is told", () => {
  it("says what happened rather than handing over a payload", () => {
    const text = summarize(delta({ changes: [change("focus-changed", "focus moved to Chrome")] }));
    expect(text).toContain("focus moved to Chrome");
  });

  it("does not recite an unbounded list", () => {
    const many = Array.from({ length: 20 }, (_, i) => change("window-opened", `window ${i}`));
    const text = summarize(delta({ changes: many }));
    expect(text.split("\n").length).toBeLessThan(10);
    expect(text).toContain("more");
  });

  it("passes on that the picture went blind, with somewhere to re-read from", () => {
    const text = summarize(
      delta({ changes: [change("window-opened", "a")], complete: false, oldestHeldRevision: 42 }),
    );
    expect(text).toContain("42");
  });
});

describe("the delivery lane", () => {
  it("does not narrate the past to a thread that just started listening", async () => {
    const desktop = new ScriptedDesktop(500, []);
    const { provider, sent } = providerOver(desktop);
    provider.subscribeThread(TARGET.threadId, TARGET.resourceId);

    await provider.poll([TARGET]);

    expect(sent).toEqual([]);
    expect(desktop.asked).toEqual([]);
  });

  it("asks from the cursor it was left at, and moves it forward", async () => {
    const desktop = new ScriptedDesktop(500, [
      delta({ changes: [change("focus-changed", "focus moved")], revision: 507 }),
      delta({ revision: 507 }),
    ]);
    const { provider, sent } = providerOver(desktop);
    provider.subscribeThread(TARGET.threadId, TARGET.resourceId);

    await provider.poll([TARGET]); // positions at 500
    await provider.poll([TARGET]); // asks since 500, delivers, moves to 507
    await provider.poll([TARGET]); // asks since 507, nothing to say

    expect(desktop.asked).toEqual([500, 507]);
    expect(sent).toHaveLength(1);
    expect(sent[0].priority).toBe("medium");
  });

  it("says nothing when nothing happened", async () => {
    const desktop = new ScriptedDesktop(1, [delta({ revision: 1 }), delta({ revision: 1 })]);
    const { provider, sent } = providerOver(desktop);
    provider.subscribeThread(TARGET.threadId, TARGET.resourceId);

    await provider.poll([TARGET]);
    await provider.poll([TARGET]);
    await provider.poll([TARGET]);

    expect(sent).toEqual([]);
  });

  it("stays quiet rather than breaking the session when the desktop is unreachable", async () => {
    const broken: DesktopSource = {
      revision: async () => {
        throw new Error("service is not running");
      },
      since: async () => {
        throw new Error("service is not running");
      },
    };
    const { provider, sent } = providerOver(broken);
    provider.subscribeThread(TARGET.threadId, TARGET.resourceId);

    await expect(provider.poll([TARGET])).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("subscribes a thread once, so a kick happens per thread and not per call", () => {
    const { provider } = providerOver(new ScriptedDesktop(0, []));
    expect(provider.subscribeThread(TARGET.threadId, TARGET.resourceId)).toBe(true);
    expect(provider.subscribeThread(TARGET.threadId, TARGET.resourceId)).toBe(false);
  });
});
