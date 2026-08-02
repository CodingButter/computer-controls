import { createTool, defineMastraCodePlugin } from "mastracode/plugin";

import { DesktopServiceError } from "./client.ts";
import * as schemas from "./schemas.generated.ts";
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
        inputSchema: schemas.getDesktopCapabilitiesParams,
        outputSchema: schemas.getDesktopCapabilitiesResult,
        execute: async () => await request("getDesktopCapabilities"),
      }),
    },

    desktop_list_applications: {
      tool: createTool({
        id: "desktop_list_applications",
        description:
          "List the applications currently running on the desktop, with their toolkit and how many windows each has. Application ids are stable for the lifetime of the application process.",
        inputSchema: schemas.listApplicationsParams,
        outputSchema: schemas.listApplicationsResult,
        execute: async () => await request("listApplications"),
      }),
    },

    desktop_list_windows: {
      tool: createTool({
        id: "desktop_list_windows",
        description:
          "List the top-level windows on the desktop, optionally narrowed to one application. Each window carries a stable id, its title, its role and whether it is the active window.",
        inputSchema: schemas.listWindowsParams,
        outputSchema: schemas.listWindowsResult,
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
        inputSchema: schemas.inspectWindowParams,
        outputSchema: schemas.inspectWindowResult,
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
        inputSchema: schemas.queryElementsParams,
        outputSchema: schemas.queryElementsResult,
        execute: async (input) => await request("queryElements", { ...input }),
      }),
    },
  },
});
