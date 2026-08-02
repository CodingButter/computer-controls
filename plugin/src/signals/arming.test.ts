import { describe, expect, it } from "vitest";

import { arm, type Armable } from "./arming.ts";
import { buildArmingProcessor, threadIdentity } from "./processor.ts";

class FakeProvider implements Armable {
  subscribed: Array<string> = [];
  kicks = 0;
  failOnSubscribe = false;
  failOnKick = false;

  subscribeThread(threadId: string, _resourceId: string): boolean {
    if (this.failOnSubscribe) throw new Error("service exploded");
    if (this.subscribed.includes(threadId)) return false;
    this.subscribed.push(threadId);
    return true;
  }

  async kickPoll(): Promise<void> {
    if (this.failOnKick) throw new Error("service exploded");
    this.kicks += 1;
  }
}

function requestContext(value: unknown) {
  return { get: (key: string) => (key === "MastraMemory" ? value : undefined) };
}

function processorArgs(value: unknown) {
  return {
    messages: [{ id: "m1" }],
    requestContext: requestContext(value),
  } as unknown as Parameters<NonNullable<ReturnType<typeof buildArmingProcessor>["processInput"]>>[0];
}

describe("arm", () => {
  it("kicks a poll only when the subscription was new", async () => {
    const provider = new FakeProvider();
    await arm(provider, "t1", "r1");
    await arm(provider, "t1", "r1");
    expect(provider.subscribed).toEqual(["t1"]);
    // A busy turn must not buy one round trip per call for a thread the lane
    // is already covering.
    expect(provider.kicks).toBe(1);
  });

  it("covers every thread the session opens, not just the first", async () => {
    const provider = new FakeProvider();
    await arm(provider, "t1", "r1");
    await arm(provider, "t2", "r1");
    expect(provider.subscribed).toEqual(["t1", "t2"]);
    expect(provider.kicks).toBe(2);
  });

  it("swallows a failing subscription rather than breaking the turn", async () => {
    const provider = new FakeProvider();
    provider.failOnSubscribe = true;
    await expect(arm(provider, "t1", "r1")).resolves.toBeUndefined();
  });

  it("swallows a failing kick rather than breaking the turn", async () => {
    const provider = new FakeProvider();
    provider.failOnKick = true;
    await expect(arm(provider, "t1", "r1")).resolves.toBeUndefined();
    expect(provider.subscribed).toEqual(["t1"]);
  });
});

describe("thread identity", () => {
  it("reads the thread and resource out of the memory context", () => {
    expect(threadIdentity(requestContext({ thread: { id: "t1" }, resourceId: "r1" }))).toEqual({
      threadId: "t1",
      resourceId: "r1",
    });
  });

  it("declines a half-identified turn instead of inventing an id", () => {
    expect(threadIdentity(requestContext({ thread: { id: "t1" } }))).toBeUndefined();
    expect(threadIdentity(requestContext({ resourceId: "r1" }))).toBeUndefined();
    expect(threadIdentity(requestContext(undefined))).toBeUndefined();
    expect(threadIdentity(undefined)).toBeUndefined();
  });
});

describe("the arming processor", () => {
  it("arms the lane on a turn that called no desktop tool", async () => {
    // This is the whole reason the processor exists. If subscription only ever
    // happened from tool-call context, the turn this asserts — an ordinary turn
    // with no desktop tool in it — is exactly the turn the push lane would be
    // unarmed for, and proof P2 would fail for an unrelated reason.
    const provider = new FakeProvider();
    const processor = buildArmingProcessor(provider);
    await processor.processInput?.(processorArgs({ thread: { id: "t1" }, resourceId: "r1" }));
    expect(provider.subscribed).toEqual(["t1"]);
    expect(provider.kicks).toBe(1);
  });

  it("returns the messages it was handed, unchanged", async () => {
    const provider = new FakeProvider();
    const processor = buildArmingProcessor(provider);
    const args = processorArgs({ thread: { id: "t1" }, resourceId: "r1" });
    const result = await processor.processInput?.(args);
    expect(result).toBe(args.messages);
  });

  it("does nothing on a turn with no memory-backed thread", async () => {
    const provider = new FakeProvider();
    const processor = buildArmingProcessor(provider);
    await processor.processInput?.(processorArgs(undefined));
    expect(provider.subscribed).toEqual([]);
  });
});
