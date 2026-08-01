// Generated from protocol/schema.json — do not edit.
// Run: node scripts/generate-protocol.mjs
// Protocol version: 1.0   schema sha256: ca625de3a33d563a

export const PROTOCOL_VERSION = "1.0" as const;
export const SCHEMA_DIGEST = "ca625de3a33d563a" as const;

/** What a method does to the world. Declared here at freeze time so enforcement can be added later without changing any request shape. */
export type OperationClass = "observe" | "edit" | "activate" | "submit" | "destructive";
export const OPERATION_CLASS_VALUES: readonly OperationClass[] = ["observe", "edit", "activate", "submit", "destructive"];

/** The complete tier vocabulary, including tiers deliberately not implemented. Declared complete at freeze so deferred backends land as additive fills rather than as a widened enum. */
export type CapabilityTier = "app-native" | "accessibility" | "compositor" | "vision" | "raw-input";
export const CAPABILITY_TIER_VALUES: readonly CapabilityTier[] = ["app-native", "accessibility", "compositor", "vision", "raw-input"];

/** How hard the service watches the desktop. Set by the client; the service reports which mode it is in. See A2 in the amendments: the runtime owns cadence because most events that justify going fast are invisible to the desktop service. */
export type ObservationMode = "active" | "idle";
export const OBSERVATION_MODE_VALUES: readonly ObservationMode[] = ["active", "idle"];

/** The complete vocabulary of semantic changes. One engine produces these for both an action's observedEffects and a pushed delta, so a reader learns one vocabulary rather than two. */
export type ChangeKind = "window-opened" | "window-closed" | "focus-changed" | "element-appeared" | "element-disappeared" | "element-state-changed" | "element-value-changed" | "element-stale";
export const CHANGE_KIND_VALUES: readonly ChangeKind[] = ["window-opened", "window-closed", "focus-changed", "element-appeared", "element-disappeared", "element-state-changed", "element-value-changed", "element-stale"];

/** Who caused a change. Three values, not two: the honest third answer exists because a revision range is a time window, and a change landing inside an action's window is not proof that the action caused it. */
export type Attribution = "self" | "external" | "unattributed";
export const ATTRIBUTION_VALUES: readonly Attribution[] = ["self", "external", "unattributed"];

/** What a caller can wait for, expressed semantically. This exists so that waiting happens in the service rather than as a sleep in the model's context. */
export type WaitCondition = "window-opened" | "window-closed" | "element-appeared" | "element-state-changed" | "revision-advanced";
export const WAIT_CONDITION_VALUES: readonly WaitCondition[] = ["window-opened", "window-closed", "element-appeared", "element-state-changed", "revision-advanced"];

/** The complete domain error vocabulary. Carried in the JSON-RPC error object under data.code. */
export type ErrorCode = "APPLICATION_NOT_FOUND" | "WINDOW_NOT_FOUND" | "ELEMENT_NOT_FOUND" | "ELEMENT_REFERENCE_STALE" | "BACKEND_UNAVAILABLE" | "ACTION_NOT_SUPPORTED" | "PERMISSION_DENIED" | "SESSION_EXPIRED" | "TIMEOUT" | "METHOD_NOT_FOUND" | "INVALID_PARAMS" | "INTERNAL_ERROR";
export const ERROR_CODE_VALUES: readonly ErrorCode[] = ["APPLICATION_NOT_FOUND", "WINDOW_NOT_FOUND", "ELEMENT_NOT_FOUND", "ELEMENT_REFERENCE_STALE", "BACKEND_UNAVAILABLE", "ACTION_NOT_SUPPORTED", "PERMISSION_DENIED", "SESSION_EXPIRED", "TIMEOUT", "METHOD_NOT_FOUND", "INVALID_PARAMS", "INTERNAL_ERROR"];

/** The result of one action, including the effects it was seen to have. A caller that reads this does not need to re-inspect. */
export interface ActionResult {
  /** Identifies this action's revision range, which the delta engine reads to attribute later changes. */
  actionId: string;
  backend: string;
  durationMs: number;
  error?: ErrorData;
  fallbacksUsed: string[];
  observedEffects?: ObservedEffects;
  ok: boolean;
}

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

/** One semantic change, produced by the single diff engine. Says what changed and where, never where on screen. */
export interface Change {
  applicationId?: string;
  attribution?: "self" | "external" | "unattributed";
  /** Kind-specific facts, such as the old and new value of a changed state. */
  detail?: Record<string, unknown>;
  elementId?: string;
  kind: "window-opened" | "window-closed" | "focus-changed" | "element-appeared" | "element-disappeared" | "element-state-changed" | "element-value-changed" | "element-stale";
  /** The revision at which this change was observed. */
  revision: number;
  /** One human-readable sentence. Passed through the value-egress point, because it can quote an element's name. */
  summary: string;
  windowId?: string;
}

/** The data member of a JSON-RPC error. The domain code lives here; the top-level code stays a reserved JSON-RPC number. */
export interface ErrorData {
  code: "APPLICATION_NOT_FOUND" | "WINDOW_NOT_FOUND" | "ELEMENT_NOT_FOUND" | "ELEMENT_REFERENCE_STALE" | "BACKEND_UNAVAILABLE" | "ACTION_NOT_SUPPORTED" | "PERMISSION_DENIED" | "SESSION_EXPIRED" | "TIMEOUT" | "METHOD_NOT_FOUND" | "INVALID_PARAMS" | "INTERNAL_ERROR";
  detail?: Record<string, unknown>;
  /** Present when this error travels inside a result rather than as a JSON-RPC error. A failed step inside a batch has no top-level error member to carry its explanation, and a report that says a step failed without saying why is not worth returning. */
  message?: string;
}

/** What happened while an action was in flight. Range-only by design: it answers 'what moved while I did that', which is a different question from 'what did I cause'. A change here may still be classed unattributed in a delta. The divergence is intended and documented. */
export interface ObservedEffects {
  changes: Change[];
  fromRevision: number;
  /** True when the settling ceiling fired before the desktop went quiet, so more effects may follow. Never omitted silently when true. */
  partial?: boolean;
  /** How long the service waited for the desktop to go quiet. */
  settledMs?: number;
  toRevision: number;
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
/** Raise and focus a window by id. Addressed semantically; no coordinates on either path. (operation class: activate) */
export interface FocusWindowParams {
  clientId?: string;
  confirm?: boolean;
  /** Quiet period the service waits for before reporting effects. The ceiling is protocol-visible rather than a magic number in the code. */
  settleMs?: number;
  windowId: string;
}
export type FocusWindowResult = ActionResult;

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

/** Inspect the subtree below an element the caller has already located. The depth budget is measured from that element, not from the window, which is the only way to reach content that sits deeper than the maximum legal depth from a window root. (operation class: observe) */
export interface InspectElementParams {
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  /** How far below the anchor to walk. The same bound window inspection uses — drilling changes where a walk starts, never how far it may go. */
  depth?: number;
  /** Where the walk starts. Must come from an earlier inspection or query: there is no way to drill into something the caller has not already seen and chosen. */
  elementId: string;
  excludeRoles?: string[];
  includeRoles?: string[];
  maxNodes?: number;
}
export interface InspectElementResult {
  backend: string;
  element: SemanticElement;
  nodeCount: number;
  revision: number;
  truncated: boolean;
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

/** Invoke a named action an element or window frame exposes. Frame actions are first class: a GTK4 window can expose dozens of them while its element tree is nearly empty. (operation class: submit) */
export interface InvokeElementParams {
  /** The action's own name, as reported in the element's actions list. Not an index: indices move. */
  action: string;
  clientId?: string;
  confirm?: boolean;
  elementId: string;
  settleMs?: number;
}
export type InvokeElementResult = ActionResult;

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

/** Run a sequence of actions in one round trip. The token-efficiency lever: a sequence costs one exchange rather than one per step. (operation class: submit) */
export interface PerformActionsParams {
  actions: {
    method: "focusWindow" | "invokeElement" | "setElementValue";
    params: Record<string, unknown>;
  }[];
  clientId?: string;
  confirm?: boolean;
  /** When true the batch halts at the first failure and reports which actions ran. Defaults to true: continuing a sequence past a step that did not happen is rarely what anyone wants. */
  stopOnFailure?: boolean;
}
export interface PerformActionsResult {
  /** How many of the requested actions ran. Less than the number requested means the batch stopped early. */
  completed: number;
  results: ActionResult[];
  revision: number;
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

/** Set an element's text through the accessibility editable-text interface, or its numeric value through the value interface. Never by synthesizing keystrokes. (operation class: edit) */
export interface SetElementValueParams {
  clientId?: string;
  confirm?: boolean;
  elementId: string;
  settleMs?: number;
  /** Text for an editable-text element, a number for a value element. The element decides which applies; a mismatch is an error rather than a coercion. */
  value: string | number;
}
export type SetElementValueResult = ActionResult;

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

/** Wait for a semantic condition. Replaces sleeping in the model's context: the waiting happens in the service and returns the moment the condition holds. (operation class: observe) */
export interface WaitForParams {
  clientId?: string;
  condition: "window-opened" | "window-closed" | "element-appeared" | "element-state-changed" | "revision-advanced";
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  elementId?: string;
  /** Matched case-insensitively as a substring, the same rule queryElements uses. */
  name?: string;
  revision?: number;
  role?: string;
  state?: string;
  timeoutMs: number;
  windowId?: string;
}
export interface WaitForResult {
  /** The change that satisfied the wait, in the same vocabulary the diff engine and the delta stream use. Absent when the condition was satisfied by the revision alone, and absent on timeout: a wait that timed out has no change to report and must not invent one. */
  change?: Change;
  /** Present when the wait was not satisfied: which condition was still false. A timeout is a normal answer, and this is the part of it a caller can act on. */
  reason?: string;
  revision: number;
  satisfied: boolean;
  waitedMs: number;
}

export type MethodName = "focusWindow" | "getDesktopCapabilities" | "getElement" | "getRevision" | "hello" | "inspectElement" | "inspectWindow" | "invokeElement" | "listApplications" | "listWindows" | "performActions" | "queryElements" | "setElementValue" | "setObservationMode" | "waitFor";

export const OPERATION_CLASS: Record<MethodName, OperationClass> = {
  focusWindow: "activate",
  getDesktopCapabilities: "observe",
  getElement: "observe",
  getRevision: "observe",
  hello: "observe",
  inspectElement: "observe",
  inspectWindow: "observe",
  invokeElement: "submit",
  listApplications: "observe",
  listWindows: "observe",
  performActions: "submit",
  queryElements: "observe",
  setElementValue: "edit",
  setObservationMode: "observe",
  waitFor: "observe",
};

export interface MethodMap {
  focusWindow: { params: FocusWindowParams; result: FocusWindowResult };
  getDesktopCapabilities: { params: GetDesktopCapabilitiesParams; result: GetDesktopCapabilitiesResult };
  getElement: { params: GetElementParams; result: GetElementResult };
  getRevision: { params: GetRevisionParams; result: GetRevisionResult };
  hello: { params: HelloParams; result: HelloResult };
  inspectElement: { params: InspectElementParams; result: InspectElementResult };
  inspectWindow: { params: InspectWindowParams; result: InspectWindowResult };
  invokeElement: { params: InvokeElementParams; result: InvokeElementResult };
  listApplications: { params: ListApplicationsParams; result: ListApplicationsResult };
  listWindows: { params: ListWindowsParams; result: ListWindowsResult };
  performActions: { params: PerformActionsParams; result: PerformActionsResult };
  queryElements: { params: QueryElementsParams; result: QueryElementsResult };
  setElementValue: { params: SetElementValueParams; result: SetElementValueResult };
  setObservationMode: { params: SetObservationModeParams; result: SetObservationModeResult };
  waitFor: { params: WaitForParams; result: WaitForResult };
}
