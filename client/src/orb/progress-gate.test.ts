/**
 * The gate exists to protect a person's attention, so it is tested as a
 * talkativeness budget rather than as a mapping function: how many sentences
 * does a busy agent earn, and does the interesting one still get through.
 */

import { describe, expect, it } from "vitest";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";

import { QUIET_MS, createProgressGate } from "./progress-gate.ts";

/** A clock a test can move, so the quiet window is asserted rather than waited for. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function toolStart(toolName: string): AgentControllerEvent {
  return { type: "tool_start", toolCallId: `call-${toolName}`, toolName, args: {} } as AgentControllerEvent;
}

function subagentStart(task: string): AgentControllerEvent {
  return {
    type: "subagent_start",
    toolCallId: `sub-${task}`,
    agentType: "execute",
    task,
    modelId: "test-model",
  } as AgentControllerEvent;
}

describe("the progress gate", () => {
  it("turns a dozen tool calls into a single sentence", () => {
    const clock = fakeClock();
    const gate = createProgressGate({ now: clock.now });

    const spoken = [
      "read_file",
      "search_content",
      "view",
      "grep",
      "list_files",
      "edit_file",
      "write_file",
      "run_tests",
      "type_check",
      "git_status",
      "git_diff",
      "format",
    ]
      .map((name) => gate.admit(toolStart(name)))
      .filter((signal): signal is string => signal !== undefined);

    // The headline property from the issue: a busy request is not a monologue.
    expect(spoken).toEqual(["You are now working on: read file."]);
  });

  it("always speaks the first thing it sees", () => {
    const gate = createProgressGate({ now: fakeClock().now });

    expect(gate.admit(toolStart("read_file"))).toBe("You are now working on: read file.");
  });

  it("reopens for a routine signal exactly when the quiet window elapses", () => {
    const clock = fakeClock();
    const gate = createProgressGate({ now: clock.now });

    gate.admit(toolStart("read_file"));

    clock.advance(QUIET_MS.routine - 1);
    expect(gate.admit(toolStart("search_content"))).toBeUndefined();

    clock.advance(1);
    expect(gate.admit(toolStart("search_content"))).toBe("You are now working on: search content.");
  });

  it("lets a notable signal through a window that still silences a routine one", () => {
    const clock = fakeClock();
    const gate = createProgressGate({ now: clock.now });

    gate.admit(toolStart("read_file"));
    clock.advance(QUIET_MS.notable);

    // Same instant, different rank: starting real work outranks opening a file.
    expect(gate.admit(toolStart("search_content"))).toBeUndefined();
    expect(gate.admit(subagentStart("auditing the payment flow"))).toBe(
      "You are now: auditing the payment flow.",
    );
  });

  it("counts a notable signal as speech for the signals that follow it", () => {
    const clock = fakeClock();
    const gate = createProgressGate({ now: clock.now });

    gate.admit(subagentStart("auditing the payment flow"));

    clock.advance(QUIET_MS.routine - 1);
    expect(gate.admit(toolStart("read_file"))).toBeUndefined();
  });

  it("refuses to repeat itself even after the window reopens", () => {
    const clock = fakeClock();
    const gate = createProgressGate({ now: clock.now });

    expect(gate.admit(toolStart("read_file"))).toBe("You are now working on: read file.");

    clock.advance(QUIET_MS.routine * 2);
    expect(gate.admit(toolStart("read_file"))).toBeUndefined();
  });

  it("spends no silence on events with nothing to say", () => {
    const clock = fakeClock();
    const gate = createProgressGate({ now: clock.now });

    expect(gate.admit(toolStart("   "))).toBeUndefined();
    expect(gate.admit(subagentStart("  "))).toBeUndefined();

    // The empty ones must not have consumed the window the real signal needs.
    expect(gate.admit(toolStart("read_file"))).toBe("You are now working on: read file.");
  });

  it("says nothing about events that are not the start of work", () => {
    const gate = createProgressGate({ now: fakeClock().now });

    expect(
      gate.admit({ type: "tool_end", toolCallId: "call-1", result: "ok", isError: false } as AgentControllerEvent),
    ).toBeUndefined();
    expect(
      gate.admit({ type: "tool_input_start", toolCallId: "call-1", toolName: "read_file" } as AgentControllerEvent),
    ).toBeUndefined();
  });

  it("says a tool name the way a person would", () => {
    const gate = createProgressGate({ now: fakeClock().now });

    expect(gate.admit(toolStart("search_content-deep"))).toBe(
      "You are now working on: search content deep.",
    );
  });
});
