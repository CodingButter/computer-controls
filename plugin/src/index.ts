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
  },
});
