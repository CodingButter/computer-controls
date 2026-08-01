import { createTool, defineMastraCodePlugin, z } from "mastracode/plugin";

import { DesktopServiceError } from "./client.ts";
import { DesktopSupervisor } from "./supervisor.ts";

/**
 * Semantic desktop control.
 *
 * Every tool here talks to the Python desktop service over a Unix socket, and
 * the service is what talks to AT-SPI. The plugin holds no desktop state of its
 * own — that is what lets the sidecar be replaced later without touching this
 * file.
 */

const supervisor = new DesktopSupervisor();

/** Turn a service error into something the model can act on rather than a stack trace. */
function describeFailure(error: unknown): never {
  if (error instanceof DesktopServiceError) {
    throw new Error(`[${error.code}] ${error.message}`);
  }
  throw error;
}

async function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  try {
    return await supervisor.request<T>(method, params);
  } catch (error) {
    return describeFailure(error);
  }
}

const tierSchema = z.object({
  id: z.string(),
  name: z.string(),
  available: z.boolean(),
  reason: z.string().nullish(),
  detail: z.record(z.string(), z.unknown()).nullish(),
});

/**
 * An element as the model sees it. Declared lazily because the shape is
 * recursive: a tree node contains nodes.
 */
const elementSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    id: z.string(),
    backend: z.string(),
    role: z.string(),
    name: z.string(),
    value: z.string().optional(),
    states: z.array(z.string()),
    actions: z.array(z.string()),
    bounds: z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .optional(),
    children: z.array(elementSchema).optional(),
    truncated: z.boolean().optional(),
  }),
);

const applicationSchema = z.object({
  id: z.string(),
  name: z.string(),
  pid: z.number(),
  toolkit: z.object({ name: z.string(), version: z.string() }),
  windowCount: z.number(),
  backend: z.string(),
});

const windowSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  applicationName: z.string(),
  title: z.string(),
  role: z.string(),
  active: z.boolean(),
  states: z.array(z.string()),
  backend: z.string(),
});

export default defineMastraCodePlugin({
  id: "desktop-control",
  name: "Semantic Desktop Control",
  version: "0.2.0",
  description:
    "Semantic control of Linux desktop applications through AT-SPI2 — applications, windows, elements, actions.",
  tools: {
    desktop_capabilities: {
      tool: createTool({
        id: "desktop_capabilities",
        description:
          "Report what this desktop session is and what this build can actually do with it: display server, desktop environment, compositor, and per-tier availability. Tiers that are unavailable say why. Call this before assuming a capability exists.",
        inputSchema: z.object({}),
        outputSchema: z.object({
          protocolVersion: z.string(),
          sessionToken: z.string(),
          session: z.object({
            displayServer: z.string(),
            sessionType: z.string(),
            desktopEnvironment: z.string(),
            compositor: z.string(),
            compositorSource: z.string(),
            display: z.string(),
            waylandDisplay: z.string(),
          }),
          tiers: z.array(tierSchema),
          recommendedBackends: z.array(z.string()),
        }),
        execute: async () => await request("getDesktopCapabilities"),
      }),
    },

    desktop_list_applications: {
      tool: createTool({
        id: "desktop_list_applications",
        description:
          "List the applications currently running on the desktop, with their toolkit and how many windows each has. Application ids are stable for the lifetime of the application process.",
        inputSchema: z.object({}),
        outputSchema: z.object({
          applications: z.array(applicationSchema),
          backend: z.string(),
        }),
        execute: async () => await request("listApplications"),
      }),
    },

    desktop_list_windows: {
      tool: createTool({
        id: "desktop_list_windows",
        description:
          "List the top-level windows on the desktop, optionally narrowed to one application. Each window carries a stable id, its title, its role and whether it is the active window.",
        inputSchema: z.object({
          applicationId: z
            .string()
            .optional()
            .describe("Only list windows belonging to this application id."),
        }),
        outputSchema: z.object({
          windows: z.array(windowSchema),
          backend: z.string(),
        }),
        execute: async (input) =>
          await request("listWindows", {
            ...(input?.applicationId ? { applicationId: input.applicationId } : {}),
          }),
      }),
    },

    desktop_inspect_window: {
      tool: createTool({
        id: "desktop_inspect_window",
        description:
          "Look inside a window and get back a compact semantic tree: roles, names, states, " +
          "available actions and stable element ids. Always bounded — prefer a shallow depth " +
          "and a role filter over a large tree, and use desktop_query_elements instead when " +
          "you are looking for something specific. Note that the window's own action list is " +
          "often the most capable surface: GTK4 applications expose their entire command set " +
          "there while their element tree is nearly empty.",
        inputSchema: z.object({
          windowId: z.string().describe("A window id from desktop_list_windows."),
          depth: z
            .number()
            .int()
            .min(1)
            .max(12)
            .optional()
            .describe("How many levels below the window to descend. Defaults to 3."),
          maxNodes: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe("Hard budget on nodes returned. Defaults to 200."),
          includeRoles: z
            .array(z.string())
            .optional()
            .describe("Only include elements with these roles, e.g. ['push button', 'entry']."),
          excludeRoles: z
            .array(z.string())
            .optional()
            .describe("Drop these roles from the result, e.g. ['filler', 'panel']."),
        }),
        outputSchema: z.object({
          window: elementSchema,
          nodeCount: z.number(),
          truncated: z.boolean(),
          revision: z.number(),
          backend: z.string(),
        }),
        execute: async (input) =>
          await request("inspectWindow", { ...input }),
      }),
    },

    desktop_query_elements: {
      tool: createTool({
        id: "desktop_query_elements",
        description:
          "Find specific elements inside a window by role, name or state — the preferred way " +
          "to locate something, because it returns a short flat list instead of a tree. " +
          "At least one filter is required. Returned element ids are stable and revision-" +
          "stamped: if the element changes before you use one, the service tells you it is " +
          "stale rather than acting on something else.",
        inputSchema: z.object({
          windowId: z.string().describe("A window id from desktop_list_windows."),
          role: z
            .string()
            .optional()
            .describe("Exact AT-SPI role, e.g. 'push button', 'entry', 'check box', 'menu item'."),
          name: z
            .string()
            .optional()
            .describe("Case-insensitive substring of the element's accessible name."),
          states: z
            .array(z.string())
            .optional()
            .describe("Only elements holding all of these states, e.g. ['enabled', 'showing']."),
          limit: z.number().int().min(1).max(200).optional().describe("Defaults to 50."),
        }),
        outputSchema: z.object({
          elements: z.array(elementSchema),
          matchCount: z.number(),
          searchTruncated: z.boolean(),
          revision: z.number(),
          backend: z.string(),
        }),
        execute: async (input) => await request("queryElements", { ...input }),
      }),
    },
  },
});
