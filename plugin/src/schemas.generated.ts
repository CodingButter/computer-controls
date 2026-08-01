// Generated from protocol/schema.json — do not edit.
// Run: node scripts/generate-protocol.mjs
// Protocol version: 1.0   schema sha256: f649b92ee4ded5d1

import { z } from "mastracode/plugin";

export const boundsSchema = z.object({
  height: z.number().int(),
  width: z.number().int(),
  x: z.number().int(),
  y: z.number().int(),
});

export const capabilityTierReportSchema = z.object({
  available: z.boolean(),
  detail: z.record(z.string(), z.unknown()).optional(),
  id: z.enum(["app-native", "accessibility", "compositor", "vision", "raw-input"]),
  name: z.string(),
  reason: z.union([z.string(), z.null()]).describe("Why it is unavailable. Required reading when available is false.").optional(),
});

export const errorDataSchema = z.object({
  code: z.enum(["APPLICATION_NOT_FOUND", "WINDOW_NOT_FOUND", "ELEMENT_NOT_FOUND", "ELEMENT_REFERENCE_STALE", "BACKEND_UNAVAILABLE", "ACTION_NOT_SUPPORTED", "PERMISSION_DENIED", "SESSION_EXPIRED", "TIMEOUT", "METHOD_NOT_FOUND", "INVALID_PARAMS", "INTERNAL_ERROR"]),
  detail: z.record(z.string(), z.unknown()).optional(),
});

export const semanticElementSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    actions: z.array(z.string()).describe("Action names invokable on this element. For a window this is often the application's whole command set."),
    backend: z.enum(["atspi", "compositor"]),
    bounds: boundsSchema.optional(),
    children: z.array(semanticElementSchema).optional(),
    extra: z.record(z.string(), z.unknown()).describe("Backend-specific detail that does not fit the common model, namespaced by backend. Present so richer backends are not flattened to a lowest common denominator.").optional(),
    id: z.string().regex(/^(el|win|app)-[0-9a-f]{12}$/).describe("Stable reference. Valid for the service instance's lifetime. Never reused for a different element."),
    name: z.string().describe("Accessible name. Passed through the value-egress point."),
    role: z.string().describe("What kind of thing it is, in the backend's vocabulary."),
    states: z.array(z.string()),
    truncated: z.boolean().describe("Present and true when children were withheld by a node budget. Never silently omitted.").optional(),
    value: z.string().describe("Current value, for elements that hold one. Passed through the value-egress point.").optional(),
  }),
);

export const getDesktopCapabilitiesParams = z.object({
  clientId: z.string().describe("Which client is asking. Multiple clients share one service instance and one element namespace; this is for audit and scope, not for addressing.").optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
});
export const getDesktopCapabilitiesResult = z.object({
  observationMode: z.enum(["active", "idle"]).optional(),
  recommendedBackends: z.array(z.string()),
  session: z.object({
    compositor: z.string().optional(),
    compositorSource: z.string().optional(),
    desktopEnvironment: z.string().optional(),
    display: z.string().optional(),
    displayServer: z.string(),
    token: z.string(),
    waylandDisplay: z.string().optional(),
  }),
  tiers: z.array(capabilityTierReportSchema),
});

export const getElementParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  elementId: z.string(),
});
export const getElementResult = z.object({
  backend: z.string(),
  element: semanticElementSchema,
  revision: z.number().int(),
});

export const getRevisionParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
});
export const getRevisionResult = z.object({
  observationMode: z.enum(["active", "idle"]).optional(),
  revision: z.number().int(),
});

export const helloParams = z.object({
  clientId: z.string().optional(),
  clientName: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  protocolVersion: z.string().regex(/^[0-9]+\.[0-9]+$/),
});
export const helloResult = z.object({
  compatible: z.boolean(),
  observationMode: z.enum(["active", "idle"]).optional(),
  protocolVersion: z.string(),
  sessionToken: z.string(),
  versionDifference: z.enum(["none", "minor"]).describe("A minor difference is reported and allowed. A major mismatch fails the call instead of appearing here."),
});

export const inspectWindowParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  depth: z.number().int().min(1).max(12).optional(),
  excludeRoles: z.array(z.string()).optional(),
  includeRoles: z.array(z.string()).optional(),
  maxNodes: z.number().int().min(1).max(1000).optional(),
  windowId: z.string(),
});
export const inspectWindowResult = z.object({
  backend: z.string(),
  nodeCount: z.number().int(),
  revision: z.number().int(),
  truncated: z.boolean(),
  window: semanticElementSchema,
});

export const listApplicationsParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
});
export const listApplicationsResult = z.object({
  applications: z.array(z.object({
    backend: z.string().describe("Which backend observed this application. Present per application for the same reason it is present per element: a mixed-backend result must stay attributable.").optional(),
    id: z.string(),
    name: z.string(),
    pid: z.number().int(),
    toolkit: z.object({
      name: z.string(),
      version: z.string(),
    }),
    windowCount: z.number().int().optional(),
  })),
  backend: z.string(),
  revision: z.number().int().optional(),
});

export const listWindowsParams = z.object({
  applicationId: z.string().optional(),
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
});
export const listWindowsResult = z.object({
  backend: z.string(),
  revision: z.number().int().optional(),
  windows: z.array(z.object({
    active: z.boolean(),
    applicationId: z.string(),
    applicationName: z.string().optional(),
    backend: z.string(),
    id: z.string(),
    role: z.string(),
    states: z.array(z.string()),
    title: z.string(),
  })),
});

export const queryElementsParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  limit: z.number().int().min(1).max(200).optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  states: z.array(z.string()).optional(),
  windowId: z.string(),
}).refine((value) => value.role !== undefined || value.name !== undefined || value.states !== undefined, { message: "at least one of role, name, states is required" });
export const queryElementsResult = z.object({
  backend: z.string(),
  elements: z.array(semanticElementSchema),
  matchCount: z.number().int(),
  moreResults: z.boolean().describe("More matches exist than were returned — either the search was cut short or the answer hit its limit with tree left unwalked. A caller seeing this should narrow its filter rather than assume it has seen everything.").optional(),
  revision: z.number().int(),
  searchTruncated: z.boolean().describe("The search gave up before covering the window."),
});

export const setObservationModeParams = z.object({
  ceilingMs: z.number().int().min(0).describe("Hard upper bound on holding a batch, so a continuously busy desktop still reports in.").optional(),
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  debounceMs: z.number().int().min(0).describe("Quiet period before a batch of changes is released.").optional(),
  mode: z.enum(["active", "idle"]),
  reconcileIntervalMs: z.number().int().min(100).describe("How often the reconciliation sweep runs in this mode. The sweep catches what the event stream dropped; it is not how changes are noticed. Idle backs this off, it does not stop subscribing.").optional(),
});
export const setObservationModeResult = z.object({
  ceilingMs: z.number().int(),
  debounceMs: z.number().int(),
  observationMode: z.enum(["active", "idle"]),
  reconcileIntervalMs: z.number().int(),
  revision: z.number().int(),
});
