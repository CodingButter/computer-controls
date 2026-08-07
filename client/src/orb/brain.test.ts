/**
 * The dispatch seam is tested through the real turn contract rather than
 * against the gate directly, because the property that matters is what a
 * listening face actually hears while one request runs.
 */

import { describe, expect, it } from "vitest";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";

import type { AgentTurn, ChatRequest } from "../chat.ts";
import { createHubBrain } from "./brain.ts";

function toolStart(toolName: string): AgentControllerEvent {
  return { type: "tool_start", toolCallId: `call-${toolName}`, toolName, args: {} } as AgentControllerEvent;
}

/** A turn that replays a scripted event stream before answering. */
function turnEmitting(events: AgentControllerEvent[], text = "Done."): AgentTurn {
  return async (request: ChatRequest) => {
    for (const event of events) request.onEvent?.(event);
    return { text, status: "ok" };
  };
}

const TWELVE_TOOLS = [
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
].map(toolStart);

describe("the hub brain", () => {
  it("narrates a twelve-tool request at most once", async () => {
    const brain = createHubBrain({ turn: turnEmitting(TWELVE_TOOLS) });
    const spoken: string[] = [];

    await brain.ask("do the thing", (signal) => spoken.push(signal));

    expect(spoken).toEqual(["You are now working on: read file."]);
  });

  it("leaves the answer untouched by the gating", async () => {
    const brain = createHubBrain({ turn: turnEmitting(TWELVE_TOOLS, "The build is green.") });

    expect(await brain.ask("do the thing", () => {})).toBe("The build is green.");
  });

  it("still says something when the agent answers with nothing", async () => {
    const brain = createHubBrain({ turn: turnEmitting(TWELVE_TOOLS, "   ") });

    expect(await brain.ask("do the thing", () => {})).toBe(
      "I did that, but there was nothing to report back.",
    );
  });

  it("gives every request its own silence to spend", async () => {
    const brain = createHubBrain({ turn: turnEmitting(TWELVE_TOOLS) });
    const first: string[] = [];
    const second: string[] = [];

    await brain.ask("do the thing", (signal) => first.push(signal));
    await brain.ask("do it again", (signal) => second.push(signal));

    // A gate hoisted to createHubBrain would leave the second request mute.
    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
  });

  it("does not ask the turn to report progress nobody is listening for", async () => {
    let sawOnEvent = true;
    const brain = createHubBrain({
      turn: async (request: ChatRequest) => {
        sawOnEvent = request.onEvent !== undefined;
        return { text: "Done.", status: "ok" };
      },
    });

    await brain.ask("do the thing");

    expect(sawOnEvent).toBe(false);
  });
});
