/**
 * The gate this phase opens with, before a line of provider code.
 *
 * The push lane rests on one claim: a desktop delta sent to a thread with no run
 * in flight is *persisted*, not *acted on*. If that claim is wrong, every delta
 * this project pushes starts a background run with no controller session behind
 * it, the model resolver dies with "No model selected", and the plugin looks
 * fine right up until the desktop gets interesting.
 *
 * Run against the real runtime, with a model that throws if anything invokes it,
 * so "persist" is proven by the absence of a model rather than by a log line.
 *
 * What it found, which the received wisdom did not say:
 *
 *   medium and high  -> routed 'deliver', the caller's ifIdle is honoured,
 *                       accepted resolves to persist, no model is touched.
 *   low              -> routed 'summarize'. The signal is not sent now at all;
 *                       there is no `accepted` to inspect. The dispatcher sends
 *                       it later and rewrites the behaviour by priority, so a
 *                       low-priority delta ends up waking a thread no matter
 *                       what its sender asked for.
 *
 * Hence the standing rule for this plugin, asserted below rather than remembered:
 * desktop deltas are sent at medium (ambient) or high (interrupt). Never low.
 */
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core";
import { InMemoryNotificationsStorage } from "@mastra/core/notifications";
import { MastraCompositeStore } from "@mastra/core/storage";
import { describe, expect, it } from "vitest";

/**
 * A model that cannot answer. If the runtime ever wakes a run for one of these
 * notifications the failure is loud and immediate, rather than a quiet
 * "No model selected" in somebody's terminal at two in the morning.
 */
const refusingModel = {
  specificationVersion: "v2" as const,
  provider: "gate",
  modelId: "refuses-to-run",
  supportedUrls: {},
  doGenerate: async () => {
    throw new Error("the model was invoked — something woke a run that should have persisted");
  },
  doStream: async () => {
    throw new Error("the model was invoked — something woke a run that should have persisted");
  },
};

function idleAgent(id: string) {
  const notifications = new InMemoryNotificationsStorage();
  const storage = new MastraCompositeStore({ id: `${id}-storage`, domains: { notifications } });
  const agent = new Agent({
    id,
    name: id,
    instructions: "gate",
    model: refusingModel as never,
  });
  new Mastra({ agents: { [id]: agent }, storage, logger: false });
  return agent;
}

function delta(priority: "low" | "medium" | "high", threadId: string) {
  return [
    {
      source: "desktop",
      kind: "delta",
      priority,
      summary: "focus moved to gnome-text-editor",
      dedupeKey: `desktop:delta:${threadId}`,
    },
    {
      resourceId: "gate-user",
      threadId,
      ifIdle: { behavior: "persist" as const },
    },
  ] as const;
}

describe("what the runtime does with a desktop delta nobody is waiting for", () => {
  it("persists an ambient delta instead of waking the thread", async () => {
    const agent = idleAgent("desktop-idle-ambient");
    const result = await agent.sendNotificationSignal(...delta("medium", "gate-ambient"));

    expect(result.decision.action).toBe("deliver");
    await expect(result.accepted).resolves.toMatchObject({ action: "persist" });
  });

  it("persists an interrupt-class delta, which is what an interrupt has to do", async () => {
    const agent = idleAgent("desktop-idle-interrupt");
    const result = await agent.sendNotificationSignal(...delta("high", "gate-interrupt"));

    expect(result.decision.action).toBe("deliver");
    await expect(result.accepted).resolves.toMatchObject({ action: "persist" });
  });

  it("shows why low priority is not available to this plugin", async () => {
    const agent = idleAgent("desktop-idle-low");
    const result = await agent.sendNotificationSignal(...delta("low", "gate-low"));

    // Deferred to a summary the dispatcher will send later under its own rules:
    // the ifIdle this caller asked for never reaches the send. Nothing to accept.
    expect(result.decision.action).toBe("summarize");
    expect(result.accepted).toBeUndefined();
  });
});
