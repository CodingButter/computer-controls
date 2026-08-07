import { describe, expect, it } from "vitest";

import { pacedTimeoutMs } from "./index.ts";

/**
 * How long a call is allowed to take is the plugin's judgement, not the
 * transport's: the shared client takes a deadline, and this is where the
 * number comes from. It stayed with `pacedTimeoutMs` when the client moved to
 * `clients/shared`.
 */

describe("deadlines for methods that take time on purpose", () => {
  it("gives a paced call as long as the typing will actually take", () => {
    // 350 characters at 70 wpm is 60 seconds of typing — three times the
    // default deadline, which would otherwise abandon a call doing its job.
    const text = "abcd ".repeat(70);
    const timeout = pacedTimeoutMs({ text, wordsPerMinute: 70 })!;
    expect(timeout).toBeGreaterThan(60_000);
    expect(timeout).toBeLessThan(120_000);
  });

  it("scales with speed rather than assuming one", () => {
    const text = "abcd ".repeat(70);
    const slow = pacedTimeoutMs({ text, wordsPerMinute: 20 })!;
    const fast = pacedTimeoutMs({ text, wordsPerMinute: 200 })!;
    expect(slow).toBeGreaterThan(fast);
  });

  it("covers a replacement typed into an edit", () => {
    expect(pacedTimeoutMs({ find: "old", replaceWith: "a new sentence" })).toBeDefined();
  });

  it("leaves ordinary calls on the default deadline", () => {
    expect(pacedTimeoutMs({ windowId: "win-1" })).toBeUndefined();
  });
});
