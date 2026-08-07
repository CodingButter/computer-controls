import { describe, expect, it } from "vitest";

import {
  HUB_FUNCTION_DECLARATION,
  HUB_FUNCTION_NAME,
  LIVE_MODEL,
  LIVE_VOICE,
  REALTIME_TOOLS,
  STOP_LISTENING_DECLARATION,
  STOP_LISTENING_NAME,
  realtimeConfig,
} from "./live.ts";

/**
 * The names that would mean the fence had failed.
 *
 * Written out rather than derived, so that a tool gaining a new name upstream
 * does not silently make this test vacuous — the point is the shape of what a
 * leak would look like, and it is checked against the actual declarations.
 */
const FORBIDDEN = [
  "execute_command",
  "write_file",
  "delete_file",
  "string_replace_lsp",
  "mkdir",
  "view",
  "find_files",
  "search_content",
  "desktop",
  "click",
  "type_text",
  "screenshot",
  "memory",
  "remember",
  "recall",
];

describe("test_the_live_provider_holds_no_desktop_or_memory_tools", () => {
  it("hands the provider exactly two tools: the hub delegation and session close", () => {
    const config = realtimeConfig({ apiKey: "k", events: events() });

    expect(config.tools).toHaveLength(2);
    expect(config.tools[0].name).toBe(HUB_FUNCTION_NAME);
    expect(config.tools[1].name).toBe(STOP_LISTENING_NAME);
  });

  it("names nothing that touches the machine or the memory", () => {
    const declared = JSON.stringify(REALTIME_TOOLS).toLowerCase();
    const names = REALTIME_TOOLS.map((tool) => tool.name);

    expect(names).toEqual([HUB_FUNCTION_NAME, STOP_LISTENING_NAME]);
    for (const forbidden of FORBIDDEN) {
      expect(names).not.toContain(forbidden);
    }
    // The description may mention the machine — it has to, to tell the provider
    // to delegate — but no tool may be *named* for it.
    expect(declared).toContain("ask_the_hub");
  });

  it("cannot be widened by a caller, because the tool set is not an argument", () => {
    const config = realtimeConfig({ apiKey: "k", events: events() });

    expect(() => {
      (config.tools as unknown as unknown[]).push({ name: "execute_command" });
    }).toThrow();
    expect(config.tools).toHaveLength(2);
  });

  it("every session this product opens gets the same fence", () => {
    const first = realtimeConfig({ apiKey: "a", events: events() });
    const second = realtimeConfig({ apiKey: "b", events: events(), model: "other" });

    expect(first.tools).toBe(REALTIME_TOOLS);
    expect(second.tools).toBe(REALTIME_TOOLS);
  });

  it("takes only a request string, so capability is described in one place", () => {
    expect(HUB_FUNCTION_DECLARATION.parameters.properties).toEqual({
      request: expect.objectContaining({ type: "string" }),
    });
    expect(HUB_FUNCTION_DECLARATION.parameters.required).toEqual(["request"]);
  });

  it("stop_listening takes no arguments — closing needs none", () => {
    expect(STOP_LISTENING_DECLARATION.parameters.properties).toEqual({});
  });

  it("pins the Live model rather than inheriting a default that can move", () => {
    expect(realtimeConfig({ apiKey: "k", events: events() }).model).toBe(LIVE_MODEL);
  });

  it("defaults to the pinned voice rather than the provider's own, which is free to move", () => {
    expect(realtimeConfig({ apiKey: "k", events: events() }).voice).toBe(LIVE_VOICE);
  });

  it("threads a chosen voice through to the provider config", () => {
    expect(realtimeConfig({ apiKey: "k", voice: "Aoede", events: events() }).voice).toBe("Aoede");
  });

  it("asks for proactive audio, which is what lets a signal be spoken unprompted", () => {
    expect(realtimeConfig({ apiKey: "k", events: events() }).proactiveAudio).toBe(true);
  });
});

function events() {
  return {
    onAudio: () => {},
    onTranscript: () => {},
    onFunctionCall: () => {},
    onBargeIn: () => {},
  };
}
