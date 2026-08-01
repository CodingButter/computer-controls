// Generated from protocol/schema.json — do not edit.
// Run: node scripts/generate-protocol.mjs
// Protocol version: 1.0   schema sha256: f649b92ee4ded5d1

export const PROTOCOL_VERSION = "1.0" as const;
export const SCHEMA_DIGEST = "f649b92ee4ded5d1" as const;

/** What a method does to the world. Declared here at freeze time so enforcement can be added later without changing any request shape. */
export type OperationClass = "observe" | "edit" | "activate" | "submit" | "destructive";
export const OPERATION_CLASS_VALUES: readonly OperationClass[] = ["observe", "edit", "activate", "submit", "destructive"];

/** The complete tier vocabulary, including tiers deliberately not implemented. Declared complete at freeze so deferred backends land as additive fills rather than as a widened enum. */
export type CapabilityTier = "app-native" | "accessibility" | "compositor" | "vision" | "raw-input";
export const CAPABILITY_TIER_VALUES: readonly CapabilityTier[] = ["app-native", "accessibility", "compositor", "vision", "raw-input"];

/** How hard the service watches the desktop. Set by the client; the service reports which mode it is in. See A2 in the amendments: the runtime owns cadence because most events that justify going fast are invisible to the desktop service. */
export type ObservationMode = "active" | "idle";
export const OBSERVATION_MODE_VALUES: readonly ObservationMode[] = ["active", "idle"];

/** The complete domain error vocabulary. Carried in the JSON-RPC error object under data.code. */
export type ErrorCode = "APPLICATION_NOT_FOUND" | "WINDOW_NOT_FOUND" | "ELEMENT_NOT_FOUND" | "ELEMENT_REFERENCE_STALE" | "BACKEND_UNAVAILABLE" | "ACTION_NOT_SUPPORTED" | "PERMISSION_DENIED" | "SESSION_EXPIRED" | "TIMEOUT" | "METHOD_NOT_FOUND" | "INVALID_PARAMS" | "INTERNAL_ERROR";
export const ERROR_CODE_VALUES: readonly ErrorCode[] = ["APPLICATION_NOT_FOUND", "WINDOW_NOT_FOUND", "ELEMENT_NOT_FOUND", "ELEMENT_REFERENCE_STALE", "BACKEND_UNAVAILABLE", "ACTION_NOT_SUPPORTED", "PERMISSION_DENIED", "SESSION_EXPIRED", "TIMEOUT", "METHOD_NOT_FOUND", "INVALID_PARAMS", "INTERNAL_ERROR"];

/** Screen rectangle in pixels. Reported for orientation and for the user's benefit; it is not an addressing mechanism and no method in this protocol accepts coordinates. */
export interface Bounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

/** One tier's availability. An unavailable tier is always reported with a reason, never omitted. */
export interface CapabilityTierReport {
  available: boolean;
  detail?: Record<string, unknown>;
  id: "app-native" | "accessibility" | "compositor" | "vision" | "raw-input";
  name: string;
  /** Why it is unavailable. Required reading when available is false. */
  reason?: string | null;
}

/** The data member of a JSON-RPC error. The domain code lives here; the top-level code stays a reserved JSON-RPC number. */
export interface ErrorData {
  code: "APPLICATION_NOT_FOUND" | "WINDOW_NOT_FOUND" | "ELEMENT_NOT_FOUND" | "ELEMENT_REFERENCE_STALE" | "BACKEND_UNAVAILABLE" | "ACTION_NOT_SUPPORTED" | "PERMISSION_DENIED" | "SESSION_EXPIRED" | "TIMEOUT" | "METHOD_NOT_FOUND" | "INVALID_PARAMS" | "INTERNAL_ERROR";
  detail?: Record<string, unknown>;
}

/** Fields every request may carry. Declared at freeze time so segment 3 adds enforcement without adding a field. */
export interface RequestCommon {
  /** Which client is asking. Multiple clients share one service instance and one element namespace; this is for audit and scope, not for addressing. */
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
}

/** Fields every response carries so a caller always knows when it was observed and how. */
export interface ResponseCommon {
  /** Which backend answered. */
  backend?: string;
  /** Backends tried before the one that answered. Empty when the preferred backend worked. */
  fallbacksUsed?: string[];
  observationMode?: "active" | "idle";
  /** The session revision these results were observed at. */
  revision?: number;
}

/** One thing on the desktop, as a caller sees it. */
export interface SemanticElement {
  /** Action names invokable on this element. For a window this is often the application's whole command set. */
  actions: string[];
  backend: "atspi" | "compositor";
  bounds?: Bounds;
  children?: SemanticElement[];
  /** Backend-specific detail that does not fit the common model, namespaced by backend. Present so richer backends are not flattened to a lowest common denominator. */
  extra?: Record<string, unknown>;
  /** Stable reference. Valid for the service instance's lifetime. Never reused for a different element. */
  id: string;
  /** Accessible name. Passed through the value-egress point. */
  name: string;
  /** What kind of thing it is, in the backend's vocabulary. */
  role: string;
  states: string[];
  /** Present and true when children were withheld by a node budget. Never silently omitted. */
  truncated?: boolean;
  /** Current value, for elements that hold one. Passed through the value-egress point. */
  value?: string;
}

/** Every method, its operation class, and its request and response shapes. */
/** What this session can and cannot do, probed rather than assumed. (operation class: observe) */
export interface GetDesktopCapabilitiesParams {
  /** Which client is asking. Multiple clients share one service instance and one element namespace; this is for audit and scope, not for addressing. */
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
}
export interface GetDesktopCapabilitiesResult {
  observationMode?: "active" | "idle";
  recommendedBackends: string[];
  session: {
    compositor?: string;
    compositorSource?: string;
    desktopEnvironment?: string;
    display?: string;
    displayServer: string;
    token: string;
    waylandDisplay?: string;
  };
  tiers: CapabilityTierReport[];
}

/** Re-describe one element by id. Raises ELEMENT_REFERENCE_STALE rather than substituting a similar element. (operation class: observe) */
export interface GetElementParams {
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  elementId: string;
}
export interface GetElementResult {
  backend: string;
  element: SemanticElement;
  revision: number;
}

/** The session's current revision. The addressing unit for deltas and causal attribution. (operation class: observe) */
export interface GetRevisionParams {
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
}
export interface GetRevisionResult {
  observationMode?: "active" | "idle";
  revision: number;
}

/** Version handshake. First call on a connection. (operation class: observe) */
export interface HelloParams {
  clientId?: string;
  clientName?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  protocolVersion: string;
}
export interface HelloResult {
  compatible: boolean;
  observationMode?: "active" | "idle";
  protocolVersion: string;
  sessionToken: string;
  /** A minor difference is reported and allowed. A major mismatch fails the call instead of appearing here. */
  versionDifference: "none" | "minor";
}

/** A compact, bounded semantic tree of one window, including the window's own actions. (operation class: observe) */
export interface InspectWindowParams {
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  depth?: number;
  excludeRoles?: string[];
  includeRoles?: string[];
  maxNodes?: number;
  windowId: string;
}
export interface InspectWindowResult {
  backend: string;
  nodeCount: number;
  revision: number;
  truncated: boolean;
  window: SemanticElement;
}

/** Applications currently running on the desktop. (operation class: observe) */
export interface ListApplicationsParams {
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
}
export interface ListApplicationsResult {
  applications: {
    /** Which backend observed this application. Present per application for the same reason it is present per element: a mixed-backend result must stay attributable. */
    backend?: string;
    id: string;
    name: string;
    pid: number;
    toolkit: {
      name: string;
      version: string;
    };
    windowCount?: number;
  }[];
  backend: string;
  revision?: number;
}

/** Top-level windows, optionally narrowed to one application. (operation class: observe) */
export interface ListWindowsParams {
  applicationId?: string;
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
}
export interface ListWindowsResult {
  backend: string;
  revision?: number;
  windows: {
    active: boolean;
    applicationId: string;
    applicationName?: string;
    backend: string;
    id: string;
    role: string;
    states: string[];
    title: string;
  }[];
}

/** Find elements in a window by role, name or state. At least one filter is required. (operation class: observe) */
export interface QueryElementsParams {
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  limit?: number;
  name?: string;
  role?: string;
  states?: string[];
  windowId: string;
}
export interface QueryElementsResult {
  backend: string;
  elements: SemanticElement[];
  matchCount: number;
  /** More matches exist than were returned — either the search was cut short or the answer hit its limit with tree left unwalked. A caller seeing this should narrow its filter rather than assume it has seen everything. */
  moreResults?: boolean;
  revision: number;
  /** The search gave up before covering the window. */
  searchTruncated: boolean;
}

/** Tell the service how hard to watch. The runtime owns cadence because the events that justify going fast — filesystem changes, transcripts, timers, agent activity — are invisible from here. (operation class: observe) */
export interface SetObservationModeParams {
  /** Hard upper bound on holding a batch, so a continuously busy desktop still reports in. */
  ceilingMs?: number;
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  /** Quiet period before a batch of changes is released. */
  debounceMs?: number;
  mode: "active" | "idle";
  /** How often the reconciliation sweep runs in this mode. The sweep catches what the event stream dropped; it is not how changes are noticed. Idle backs this off, it does not stop subscribing. */
  reconcileIntervalMs?: number;
}
export interface SetObservationModeResult {
  ceilingMs: number;
  debounceMs: number;
  observationMode: "active" | "idle";
  reconcileIntervalMs: number;
  revision: number;
}

export type MethodName = "getDesktopCapabilities" | "getElement" | "getRevision" | "hello" | "inspectWindow" | "listApplications" | "listWindows" | "queryElements" | "setObservationMode";

export const OPERATION_CLASS: Record<MethodName, OperationClass> = {
  getDesktopCapabilities: "observe",
  getElement: "observe",
  getRevision: "observe",
  hello: "observe",
  inspectWindow: "observe",
  listApplications: "observe",
  listWindows: "observe",
  queryElements: "observe",
  setObservationMode: "observe",
};

export interface MethodMap {
  getDesktopCapabilities: { params: GetDesktopCapabilitiesParams; result: GetDesktopCapabilitiesResult };
  getElement: { params: GetElementParams; result: GetElementResult };
  getRevision: { params: GetRevisionParams; result: GetRevisionResult };
  hello: { params: HelloParams; result: HelloResult };
  inspectWindow: { params: InspectWindowParams; result: InspectWindowResult };
  listApplications: { params: ListApplicationsParams; result: ListApplicationsResult };
  listWindows: { params: ListWindowsParams; result: ListWindowsResult };
  queryElements: { params: QueryElementsParams; result: QueryElementsResult };
  setObservationMode: { params: SetObservationModeParams; result: SetObservationModeResult };
}
