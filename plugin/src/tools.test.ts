import { describe, expect, it } from "vitest";

import type { MastraCodePluginContext } from "@mastra/code-sdk/plugin";

import plugin from "./index.ts";

/**
 * The tools' schemas are the first line of defence against the failure this
 * project exists to prevent: a model asking for a whole accessibility tree.
 * The service rejects an unfiltered query too, but a schema that permits one
 * means the model has to be *told no* at runtime instead of never forming the
 * request.
 */

function ctx(config: Record<string, string | boolean | undefined> = {}): MastraCodePluginContext {
  return { cwd: ".", scope: "project", pluginDir: ".", config };
}

/** Full scope so every tool is minted and existing schema tests run unchanged. */
const tools = (plugin.tools as Function)(ctx({ scope: "observe,edit,activate,submit,destructive" })) as Record<
  string,
  { tool: { id: string; description: string; inputSchema: any } }
>;

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

describe("typing and editing", () => {
  it("offers both a paced door and an atomic one", () => {
    // A10: the legible variant may never be the only way to do something.
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["desktop_type_text", "desktop_set_element_value", "desktop_edit_text"]),
    );
  });

  it("bounds how much text one call may carry and how fast it may arrive", () => {
    const typing = schemaOf("desktop_type_text");
    expect(typing.safeParse({ elementId: "el-1", text: "x".repeat(9000) }).success).toBe(false);
    expect(typing.safeParse({ elementId: "el-1", text: "hello", wordsPerMinute: 5000 }).success).toBe(false);
    expect(typing.safeParse({ elementId: "el-1", text: "hello", wordsPerMinute: 70 }).success).toBe(true);
  });

  it("edits are addressed by text, never by offsets", () => {
    const editing = schemaOf("desktop_edit_text");
    expect(editing.safeParse({ elementId: "el-1", start: 3, end: 9 }).success).toBe(false);
    expect(editing.safeParse({ elementId: "el-1", find: "old words" }).success).toBe(true);
  });

  it("tells the model that a stopped call is still a result", () => {
    expect(tools.desktop_type_text.tool.description).toMatch(/progress/i);
    expect(tools.desktop_type_text.tool.description).toMatch(/read back/i);
    expect(tools.desktop_edit_text.tool.description).toMatch(/exactly once/i);
  });
});

describe("construction-time scope minting", () => {
  it("never mints desktop_grant_scope regardless of scope", () => {
    // A13: the agent holds no key. Granting is a client operation before the
    // agent exists — the model is never handed a tool that asks for more.
    const all = Object.keys(
      (plugin.tools as Function)(ctx({ scope: "observe,edit,activate,submit,destructive" })),
    );
    expect(all).not.toContain("desktop_grant_scope");

    const observeOnly = Object.keys((plugin.tools as Function)(ctx({ scope: "observe" })));
    expect(observeOnly).not.toContain("desktop_grant_scope");

    const empty = Object.keys((plugin.tools as Function)(ctx({})));
    expect(empty).not.toContain("desktop_grant_scope");
  });

  it("mints only observe-class tools when scope is observe", () => {
    const names = Object.keys((plugin.tools as Function)(ctx({ scope: "observe" })));
    // Observe tools present.
    expect(names).toEqual(
      expect.arrayContaining([
        "desktop_capabilities",
        "desktop_list_windows",
        "desktop_inspect_window",
        "desktop_audit_tail",
        "desktop_emergency_stop",
      ]),
    );
    // Acting tools absent.
    for (const acting of [
      "desktop_type_text",
      "desktop_edit_text",
      "desktop_focus_window",
      "desktop_invoke_element",
      "desktop_launch_application",
    ]) {
      expect(names).not.toContain(acting);
    }
  });

  it("mints observe and edit tools when scope includes edit", () => {
    const names = Object.keys((plugin.tools as Function)(ctx({ scope: "observe,edit" })));
    expect(names).toEqual(
      expect.arrayContaining([
        "desktop_capabilities",
        "desktop_type_text",
        "desktop_edit_text",
        "desktop_claim_element",
      ]),
    );
    // Still no activate/submit.
    expect(names).not.toContain("desktop_focus_window");
    expect(names).not.toContain("desktop_invoke_element");
  });

  it("defaults to observe-only when no config is given", () => {
    const names = Object.keys((plugin.tools as Function)(ctx({})));
    expect(names).toContain("desktop_capabilities");
    expect(names).not.toContain("desktop_type_text");
    expect(names).not.toContain("desktop_invoke_element");
  });
});
