// Generated from protocol/schema.json — do not edit.
// Run: node scripts/generate-protocol.mjs
// Protocol version: 1.0   schema sha256: 7f24dc637f2a4cae

import { z } from "mastracode/plugin";

export const changeSchema = z.object({
  applicationId: z.string().optional(),
  attribution: z.enum(["self", "external", "unattributed"]).optional(),
  detail: z.record(z.string(), z.unknown()).describe("Kind-specific facts, such as the old and new value of a changed state.").optional(),
  elementId: z.string().optional(),
  kind: z.enum(["window-opened", "window-closed", "focus-changed", "element-appeared", "element-disappeared", "element-state-changed", "element-value-changed", "element-stale"]),
  revision: z.number().int().min(0).describe("The revision at which this change was observed."),
  summary: z.string().describe("One human-readable sentence. Passed through the value-egress point, because it can quote an element's name."),
  windowId: z.string().optional(),
});

export const observedEffectsSchema = z.object({
  changes: z.array(changeSchema),
  fromRevision: z.number().int().min(0),
  partial: z.boolean().describe("True when the settling ceiling fired before the desktop went quiet, so more effects may follow. Never omitted silently when true.").optional(),
  settledMs: z.number().int().min(0).describe("How long the service waited for the desktop to go quiet.").optional(),
  toRevision: z.number().int().min(0),
});

export const errorDataSchema = z.object({
  code: z.enum(["APPLICATION_NOT_FOUND", "WINDOW_NOT_FOUND", "ELEMENT_NOT_FOUND", "ELEMENT_REFERENCE_STALE", "BACKEND_UNAVAILABLE", "ACTION_NOT_SUPPORTED", "PERMISSION_DENIED", "SESSION_EXPIRED", "TIMEOUT", "METHOD_NOT_FOUND", "INVALID_PARAMS", "INTERNAL_ERROR"]),
  detail: z.record(z.string(), z.unknown()).optional(),
  message: z.string().describe("Present when this error travels inside a result rather than as a JSON-RPC error. A failed step inside a batch has no top-level error member to carry its explanation, and a report that says a step failed without saying why is not worth returning.").optional(),
});

export const actionResultSchema = z.object({
  actionId: z.string().describe("Identifies this action's revision range, which the delta engine reads to attribute later changes."),
  backend: z.string(),
  durationMs: z.number().int().min(0),
  error: errorDataSchema.optional(),
  fallbacksUsed: z.array(z.string()),
  observedEffects: observedEffectsSchema.optional(),
  ok: z.boolean(),
});

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

export const focusWindowParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().optional(),
  settleMs: z.number().int().min(0).max(10000).describe("Quiet period the service waits for before reporting effects. The ceiling is protocol-visible rather than a magic number in the code.").optional(),
  windowId: z.string(),
});
export const focusWindowResult = z.record(z.string(), z.unknown());

export const getDeltaSinceParams = z.object({
  clientId: z.string().describe("Who is asking. Attribution is computed for this caller: the same change reads as 'self' to the client that caused it and 'external' to everyone else.").optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  sinceRevision: z.number().int().min(0).describe("The last revision this caller has seen. Changes at or below it are not repeated."),
});
export const getDeltaSinceResult = z.object({
  changes: z.array(changeSchema),
  complete: z.boolean().describe("False when the caller fell so far behind that the oldest changes it missed are no longer held. An incomplete answer that looked complete would be a lie that reads like calm: a caller told false should re-read rather than assume the quiet was real."),
  resumeRevision: z.number().int().min(0).describe("Present when complete is false: the earliest cursor that still yields everything the service holds. Pass it as sinceRevision to resume without a gap. It is a cursor, not the oldest surviving change — sinceRevision is exclusive, so returning the oldest surviving revision would make the caller skip it.").optional(),
  revision: z.number().int().min(0),
});

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

export const getDesktopStateParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
});
export const getDesktopStateResult = z.object({
  activeWindowId: z.string().describe("Empty when nothing on this desktop holds focus, which is a real state and not an error."),
  observationMode: z.enum(["active", "idle"]).optional(),
  revision: z.number().int().min(0),
  windows: z.array(z.object({
    active: z.boolean(),
    applicationId: z.string(),
    applicationName: z.string().optional(),
    role: z.string(),
    title: z.string(),
    windowId: z.string(),
  })),
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

export const inspectElementParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  depth: z.number().int().min(1).max(12).describe("How far below the anchor to walk. The same bound window inspection uses — drilling changes where a walk starts, never how far it may go.").optional(),
  elementId: z.string().describe("Where the walk starts. Must come from an earlier inspection or query: there is no way to drill into something the caller has not already seen and chosen."),
  excludeRoles: z.array(z.string()).optional(),
  includeRoles: z.array(z.string()).optional(),
  maxNodes: z.number().int().min(1).max(1000).optional(),
});
export const inspectElementResult = z.object({
  backend: z.string(),
  element: semanticElementSchema,
  nodeCount: z.number().int().min(0),
  revision: z.number().int().min(0),
  truncated: z.boolean(),
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

export const invokeElementParams = z.object({
  action: z.string().describe("The action's own name, as reported in the element's actions list. Not an index: indices move."),
  clientId: z.string().optional(),
  confirm: z.boolean().optional(),
  elementId: z.string(),
  settleMs: z.number().int().min(0).max(10000).optional(),
});
export const invokeElementResult = z.record(z.string(), z.unknown());

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

export const performActionsParams = z.object({
  actions: z.array(z.object({
    method: z.enum(["focusWindow", "invokeElement", "setElementValue"]),
    params: z.record(z.string(), z.unknown()),
  })),
  clientId: z.string().optional(),
  confirm: z.boolean().optional(),
  stopOnFailure: z.boolean().describe("When true the batch halts at the first failure and reports which actions ran. Defaults to true: continuing a sequence past a step that did not happen is rarely what anyone wants.").optional(),
});
export const performActionsResult = z.object({
  completed: z.number().int().min(0).describe("How many of the requested actions ran. Less than the number requested means the batch stopped early."),
  results: z.array(actionResultSchema),
  revision: z.number().int().min(0),
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

export const setElementValueParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().optional(),
  elementId: z.string(),
  settleMs: z.number().int().min(0).max(10000).optional(),
  value: z.union([z.string(), z.number()]).describe("Text for an editable-text element, a number for a value element. The element decides which applies; a mismatch is an error rather than a coercion."),
});
export const setElementValueResult = z.record(z.string(), z.unknown());

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

export const waitForParams = z.object({
  clientId: z.string().optional(),
  condition: z.enum(["window-opened", "window-closed", "element-appeared", "element-state-changed", "revision-advanced"]),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  elementId: z.string().optional(),
  name: z.string().describe("Matched case-insensitively as a substring, the same rule queryElements uses.").optional(),
  revision: z.number().int().min(0).optional(),
  role: z.string().optional(),
  state: z.string().optional(),
  timeoutMs: z.number().int().min(1).max(120000),
  windowId: z.string().optional(),
});
export const waitForResult = z.object({
  change: changeSchema.describe("The change that satisfied the wait, in the same vocabulary the diff engine and the delta stream use. Absent when the condition was satisfied by the revision alone, and absent on timeout: a wait that timed out has no change to report and must not invent one.").optional(),
  reason: z.string().describe("Present when the wait was not satisfied: which condition was still false. A timeout is a normal answer, and this is the part of it a caller can act on.").optional(),
  revision: z.number().int().min(0),
  satisfied: z.boolean(),
  waitedMs: z.number().int().min(0),
});
