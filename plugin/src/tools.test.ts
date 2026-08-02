import { describe, expect, it } from "vitest";

import plugin from "./index.ts";

/**
 * The tools' schemas are the first line of defence against the failure this
 * project exists to prevent: a model asking for a whole accessibility tree.
 * The service rejects an unfiltered query too, but a schema that permits one
 * means the model has to be *told no* at runtime instead of never forming the
 * request.
 */

const tools = plugin.tools as Record<string, { tool: { id: string; description: string; inputSchema: any } }>;

function schemaOf(name: string) {
  const entry = tools[name];
  if (!entry) throw new Error(`no tool named ${name}`);
  return entry.tool.inputSchema;
}

describe("inspection tool schemas", () => {
  it("registers both inspection tools", () => {
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["desktop_inspect_window", "desktop_query_elements"]),
    );
  });

  it("bounds depth and node count on inspection", () => {
    const schema = schemaOf("desktop_inspect_window");
    expect(schema.safeParse({ windowId: "win-1", depth: 99 }).success).toBe(false);
    expect(schema.safeParse({ windowId: "win-1", maxNodes: 100000 }).success).toBe(false);
    expect(schema.safeParse({ windowId: "win-1", depth: 3, maxNodes: 200 }).success).toBe(true);
  });

  it("requires a window id", () => {
    expect(schemaOf("desktop_inspect_window").safeParse({}).success).toBe(false);
    expect(schemaOf("desktop_query_elements").safeParse({}).success).toBe(false);
  });

  it("bounds the number of query results", () => {
    const schema = schemaOf("desktop_query_elements");
    expect(schema.safeParse({ windowId: "w", role: "push button", limit: 5000 }).success).toBe(false);
    expect(schema.safeParse({ windowId: "w", role: "push button", limit: 20 }).success).toBe(true);
  });

  it("steers the model toward filtered queries in its descriptions", () => {
    expect(tools.desktop_query_elements.tool.description).toMatch(/at least one filter/i);
    expect(tools.desktop_inspect_window.tool.description).toMatch(/bounded/i);
    // The GTK4 lesson has to reach the model, not just the code comments.
    expect(tools.desktop_inspect_window.tool.description).toMatch(/action list/i);
  });
});
