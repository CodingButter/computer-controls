// Generated from protocol/schema.json — do not edit.
// Run: node scripts/generate-protocol.mjs
// Protocol version: 1.0   schema sha256: df835e41b95f379e

export const PROTOCOL_VERSION = "1.0" as const;
export const SCHEMA_DIGEST = "df835e41b95f379e" as const;

/** What a method does to the world. Declared here at freeze time so enforcement can be added later without changing any request shape. */
export type OperationClass = "observe" | "edit" | "activate" | "submit" | "destructive";
export const OPERATION_CLASS_VALUES: readonly OperationClass[] = ["observe", "edit", "activate", "submit", "destructive"];

/** The complete tier vocabulary, including tiers deliberately not implemented. Declared complete at freeze so deferred backends land as additive fills rather than as a widened enum. */
export type CapabilityTier = "app-native" | "accessibility" | "compositor" | "vision" | "raw-input";
export const CAPABILITY_TIER_VALUES: readonly CapabilityTier[] = ["app-native", "accessibility", "compositor", "vision", "raw-input"];

/** How hard the service watches the desktop. Set by the client; the service reports which mode it is in. See A2 in the amendments: the runtime owns cadence because most events that justify going fast are invisible to the desktop service. */
export type ObservationMode = "active" | "idle";
export const OBSERVATION_MODE_VALUES: readonly ObservationMode[] = ["active", "idle"];

/** How far into what it is watching a client wants to see. Attention is not permission: it narrows what one connection is shown, inside whatever the consent ceiling already allows. See A11 in the amendments. */
export type AttentionDepth = "surface" | "tree";
export const ATTENTION_DEPTH_VALUES: readonly AttentionDepth[] = ["surface", "tree"];

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
export type ErrorCode = "APPLICATION_NOT_FOUND" | "WINDOW_NOT_FOUND" | "ELEMENT_NOT_FOUND" | "ELEMENT_REFERENCE_STALE" | "BACKEND_UNAVAILABLE" | "ACTION_NOT_SUPPORTED" | "PERMISSION_DENIED" | "SESSION_EXPIRED" | "ELEMENT_HELD" | "CLAIM_EXPIRED" | "SUBSCRIPTION_LIMIT_REACHED" | "ATTESTATION_FAILED" | "ATTESTATION_STALE" | "TIMEOUT" | "METHOD_NOT_FOUND" | "INVALID_PARAMS" | "INTERNAL_ERROR";
export const ERROR_CODE_VALUES: readonly ErrorCode[] = ["APPLICATION_NOT_FOUND", "WINDOW_NOT_FOUND", "ELEMENT_NOT_FOUND", "ELEMENT_REFERENCE_STALE", "BACKEND_UNAVAILABLE", "ACTION_NOT_SUPPORTED", "PERMISSION_DENIED", "SESSION_EXPIRED", "ELEMENT_HELD", "CLAIM_EXPIRED", "SUBSCRIPTION_LIMIT_REACHED", "ATTESTATION_FAILED", "ATTESTATION_STALE", "TIMEOUT", "METHOD_NOT_FOUND", "INVALID_PARAMS", "INTERNAL_ERROR"];

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
  /** How far an action that takes real time actually got, present whether or not it succeeded. An action interrupted partway has still changed the desktop, so a deadline or a stalled application is reported here rather than raised: the caller reads how much landed, decides whether waiting is still reasonable, and acts on the state instead of on the absence of an answer. */
  progress?: Record<string, unknown>;
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
  /** The application this change happened in. Present because the identifier above is opaque, and a reader deciding whether a change concerns them should not have to look one up to find out. */
  applicationName?: string;
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

/** One client's exclusive right to write one element, for a bounded time. A claim is not permission — permission is a separate question, already answered by the consent ceiling — and it is not a queue. It answers only 'who is allowed to be mid-sentence in this field right now'. */
export interface ElementClaim {
  /** The issued identity holding the claim, never a name a client chose for itself. */
  clientId: string;
  /** The holder's readable label, for telling a person who is in their field. */
  clientLabel?: string;
  elementId: string;
  /** Time left on the lease, as of this answer. */
  expiresInMs: number;
  heldForMs: number;
  /** The lease as granted, so a caller can tell a long claim from an old one. */
  leaseMs: number;
  /** What the holder said it was doing. Present when it said. */
  reason?: string;
}

/** The data member of a JSON-RPC error. The domain code lives here; the top-level code stays a reserved JSON-RPC number. */
export interface ErrorData {
  code: "APPLICATION_NOT_FOUND" | "WINDOW_NOT_FOUND" | "ELEMENT_NOT_FOUND" | "ELEMENT_REFERENCE_STALE" | "BACKEND_UNAVAILABLE" | "ACTION_NOT_SUPPORTED" | "PERMISSION_DENIED" | "SESSION_EXPIRED" | "ELEMENT_HELD" | "TIMEOUT" | "METHOD_NOT_FOUND" | "INVALID_PARAMS" | "INTERNAL_ERROR" | "SUBSCRIPTION_LIMIT_REACHED" | "ATTESTATION_FAILED" | "ATTESTATION_STALE";
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

/** A place in the accessibility tree that a permission hangs on, and what may be done there. An application is the outermost place there is, and most tasks mean something far narrower: 'fill in this form' expressed as 'edit anything in the browser' draws the boundary around the wrong thing. Anchors are resolved against the live tree on every call, never remembered as an answer, and the nearest one covering the target decides — so a subtree granted observe with one field inside it granted edit composes without either rule knowing about the other. */
export interface ScopeAnchor {
  /** Whether this speaks for everything under it or only for the one node it names. Defaults to false: a grant on a single field that silently reached everything beneath it would be the widening anchors exist to prevent. */
  coversDescendants?: boolean;
  /** What may be done at this place. Faces the ceiling like every other class named in a grant: an anchor is a narrowing device, never a side door. */
  operationClasses: "observe" | "edit" | "activate" | "submit" | "destructive"[];
  /** The place this hangs on: an element id, a window id, or an application name. Ids are matched exactly, because an id is minted rather than typed and a substring of one is a coincidence. Application names are matched as substrings, the same way they are everywhere else. */
  target: string;
}

/** One thing on the desktop, as a caller sees it. */
export interface SemanticElement {
  /** Action names invokable on this element. For a window this is often the application's whole command set. */
  actions: string[];
  /** Ancestor chain for this element, nearest first, up to the requested depth. Present only when the caller asked for ancestor expansion. Each entry is a full element whose id is valid for getElement. */
  ancestry?: SemanticElement[];
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
  /** Immediate neighbours of this element under the same parent, up to a per-hit cap. Present only when the caller asked for sibling expansion. */
  siblings?: SemanticElement[];
  states: string[];
  /** Present and true when this element has children the walk did not return, whether because the node budget ran out or because the depth limit was reached. Never silently omitted: a subtree that was cut off must never be indistinguishable from one that ended. Drill from this element with inspectElement to see what is below it. */
  truncated?: boolean;
  /** Current value, for elements that hold one. Passed through the value-egress point. */
  value?: string;
}

/** Every method, its operation class, and its request and response shapes. */
/** Read and record what is in a field right now, so a later commitElement can refuse if it has changed. The evidence is the field's own contents read by the service — the caller writes the argument (which element), never the evidence (what text). A masked field, whose contents even the accessibility layer cannot read, is refused: there is nothing to attest that a later commit could compare against. Composing is not sending, and this call authorises nothing: it takes a snapshot, and the snapshot is only as good as the moment it was taken. (operation class: observe) */
export interface AttestElementParams {
  clientId?: string;
  confirm?: boolean;
  /** The field whose contents are being attested for a later commit. */
  elementId: string;
}
export interface AttestElementResult {
  /** Identifies this attestation. Present it to commitElement within its TTL; one attestation admits exactly one commit. */
  attestationId: string;
  /** How long before the attestation must be retaken. A stale attestation is not reusable. */
  expiresInMs: number;
}

/** The most recent entries from this service's audit log, including the calls that were refused. Refusals are the half worth reading: an agent that tried to close a window and was told no is a fact about the agent, and it is invisible in a record of what succeeded. Entries carry what was done and to which application, never the contents of anything read or typed. (operation class: observe) */
export interface AuditTailParams {
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  limit?: number;
}
export interface AuditTailResult {
  entries: Record<string, never>[];
  path: string;
  /** Records this service could not write. Non-zero means the log is incomplete, which a reader has to be told rather than left to infer from a gap. */
  writeFailures?: number;
  written?: number;
}

/** The pixels of one window, for content the accessibility layer cannot express — what an image shows, what a canvas drew. Takes a window id and never a screen region, so only that window is ever in frame and the addressing model gains no second, weaker form. Look at the picture; still act through element references. (operation class: observe) */
export interface CaptureWindowParams {
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  /** Scale the image down to at most this width. Only ever downward: enlarging a capture invents detail that was never captured. */
  maxWidth?: number;
  windowId: string;
}
export interface CaptureWindowResult {
  backend: string;
  capturedHeight?: number;
  /** Width before the invisible client-side-decoration margin was cropped away. Differs from width on GTK windows, which reserve room for their own drop shadow. */
  capturedWidth?: number;
  format: "png";
  frameCropped?: boolean;
  height: number;
  /** The image itself, base64-encoded, so a capture travels over any transport this protocol is carried on rather than only over one with a shared filesystem. */
  image: string;
  revision: number;
  scaled?: boolean;
  width: number;
  windowId: string;
}

/** Take exclusive write ownership of one element for a bounded time, across as many calls as the work takes. No write is ever unowned — a write with no claim behind it takes one for its own duration and gives it back — so this is not a step to be added before every typeText. It is what closes the gap between two calls a caller thinks of as one piece of work: read the field, decide, type, check, type again. A claimed element cannot be taken by anyone else until it is released or its lease runs out — there is no preemption by a second agent, because the thing being protected is a sentence that is only half typed. The lease is sized by the work rather than by a house number: give estimatedWorkMs, or give the text about to be typed and let the service compute it with the same cadence arithmetic the typing itself uses, so the estimate and the work cannot drift apart. A lease is capped at ten minutes however long the work is, so work longer than that is claimed again as it goes; and a lease never ends in the middle of a write it is covering, because it exists to bound how long an element is held between calls rather than to interrupt one. A claim that has run out by the time the next write arrives is the caller having estimated badly, which it is told once, by name, rather than discovering later as somebody else's refusal. The person at the keyboard is not a client and holds no claim; their arrival still ends any write in the field they touch, and no claim outranks that. (operation class: edit) */
export interface ClaimElementParams {
  clientId?: string;
  confirm?: boolean;
  elementId: string;
  /** How long the caller believes its work will take. The lease is this plus a settling margin. Bounded, because a lease nobody can outlive is ownership wearing a lease's name. */
  estimatedWorkMs?: number;
  /** Instead of an estimate: the text about to be typed. The service sizes the lease from it at the words-per-minute given, using the arithmetic the typing will use. */
  forText?: string;
  /** What this claim is for, in the caller's words. Shown to whoever is refused, and recorded in the audit log. */
  reason?: string;
  wordsPerMinute?: number;
}
export interface ClaimElementResult {
  claim: ElementClaim;
  revision: number;
}

/** Send what was attested. Re-reads the field and refuses if it no longer matches what attestElement recorded; if it matches, triggers the element's own action. Success is asserted from the observed effect — the field is now empty, meaning it transmitted — not from the action call returning true. A field that the action was called on but which still contains its contents afterwards is a commit that did not send, reported as failure regardless of what the action call returned. The thing that would have caught the original incident: a keystroke that typed a character instead of pressing Return leaves the field non-empty, and that is the failure this reports. (operation class: destructive) */
export interface CommitElementParams {
  /** The action to trigger, as reported in the element's actions list. Not an index: indices move. When omitted, the element's first action is used. */
  action?: string;
  /** The attestation returned by attestElement for this field. One attestation admits one commit; a second commit with the same id is refused. */
  attestationId: string;
  clientId?: string;
  confirm?: boolean;
  /** The field whose attested contents are being sent. */
  elementId: string;
  settleMs?: number;
}
export type CommitElementResult = ActionResult;

/** Replace or remove part of an editable element's text, addressed by the text itself rather than by character offsets. Editing at this layer is a splice — a range is removed and something is put in its place in one operation — because there is no keyboard here and nothing to press backspace on. An offset computed from a field somebody has since typed into points at the wrong characters; text that has moved is simply not found, which is a refusal instead of a wrong edit. (operation class: edit) */
export interface EditTextParams {
  clientId?: string;
  confirm?: boolean;
  elementId: string;
  /** The existing text to replace. Must appear exactly once: two matches mean the caller does not know which one it meant, and the edit is refused rather than guessed. */
  find: string;
  /** What to put in its place. Omit to delete the range outright. */
  replaceWith?: string;
  settleMs?: number;
  /** Highlight the range before removing it, so a watching human sees what changed. Presentation only: the edit does not need it. */
  showSelection?: boolean;
  /** When present the replacement is typed at this speed rather than inserted at once, for an edit a person is watching. */
  wordsPerMinute?: number;
}
export type EditTextResult = ActionResult;

/** Revoke every grant on this service and refuse everything but observation until it is deliberately cleared. It does not time out. What it cannot do is take back an action already handed to a toolkit: there is no un-click, and a stop that implied otherwise would be worse than none, because somebody would rely on it. Classified as observe so that a client with no grant left can still pull it. (operation class: observe) */
export interface EmergencyStopParams {
  /** Lift a stop rather than raise one. Separate and deliberate: a stop that any subsequent call could clear as a side effect would be a suggestion. */
  clear?: boolean;
  clientId?: string;
  confirm?: boolean;
  reason?: string;
}
export interface EmergencyStopResult {
  grantsRevoked: number;
  /** Actions already dispatched when the stop landed. These are the ones nobody can call back. */
  inFlight?: number;
  stopped: boolean;
}

/** Raise and focus a window by id. Addressed semantically; no coordinates on either path. (operation class: activate) */
export interface FocusWindowParams {
  clientId?: string;
  confirm?: boolean;
  /** Quiet period the service waits for before reporting effects. The ceiling is protocol-visible rather than a magic number in the code. */
  settleMs?: number;
  windowId: string;
}
export type FocusWindowResult = ActionResult;

/** Everything that changed since a revision the caller already knows about, attributed for this caller. The same engine answers this and pushes unsolicited deltas, so a caller that polls and a caller that listens are never told different stories about one desktop. (operation class: observe) */
export interface GetDeltaSinceParams {
  /** Who is asking. Attribution is computed for this caller: the same change reads as 'self' to the client that caused it and 'external' to everyone else. */
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  /** The last revision this caller has seen. Changes at or below it are not repeated. */
  sinceRevision: number;
}
export interface GetDeltaSinceResult {
  changes: Change[];
  /** False when the caller fell so far behind that the oldest changes it missed are no longer held. An incomplete answer that looked complete would be a lie that reads like calm: a caller told false should re-read rather than assume the quiet was real. */
  complete: boolean;
  /** Present when complete is false: the earliest cursor that still yields everything the service holds. Pass it as sinceRevision to resume without a gap. It is a cursor, not the oldest surviving change — sinceRevision is exclusive, so returning the oldest surviving revision would make the caller skip it. */
  resumeRevision?: number;
  revision: number;
}

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

/** The current picture in one call: which windows exist and which one has focus. What a caller reads to re-acquire the desktop after being told its delta was incomplete. (operation class: observe) */
export interface GetDesktopStateParams {
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
}
export interface GetDesktopStateResult {
  /** Empty when nothing on this desktop holds focus, which is a real state and not an error. */
  activeWindowId: string;
  observationMode?: "active" | "idle";
  revision: number;
  windows: {
    active: boolean;
    applicationId: string;
    applicationName?: string;
    role: string;
    title: string;
    windowId: string;
  }[];
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

/** Ask for the operation classes this client may use, within the ceiling the user's configuration sets. Only ever narrows: a request above the ceiling is refused by naming the config key, because the answer to 'why can't I' should be a file the user owns rather than a shrug. Classified as observe so that a client holding nothing can still ask — refusing the request for permission is not a security boundary, it is a dead end. (operation class: observe) */
export interface GrantScopeParams {
  /** Places in the tree this grant hangs on, instead of hanging on whole applications. A grant that names anchors has said where it applies, so anywhere else is outside it — the same rule naming applications individually has always had. Omit to grant across applications as before. */
  anchors?: ScopeAnchor[];
  /** Application names this grant covers, matched as substrings of the application's own name. Omit for every application the configuration allows. Never matched against window titles: a title is text the user typed, and a boundary drawn on it can be moved by typing. */
  applications?: string[];
  clientId?: string;
  confirm?: boolean;
  /** The questions a commit made under this grant must be answered against. Declared here, at the door, because the party being graded does not write the rubric — a worker cannot reach this field, and the service's own mechanical criteria are asked on top of whatever is named here. A name this service cannot decide is still carried and reported as unchecked, so that asking for review is never worse than asking for nothing. */
  criteria?: string[];
  /** What this client intends to do. Ask for what the task needs and no more: a grant is also a description of the blast radius in the audit log. */
  operationClasses: "observe" | "edit" | "activate" | "submit" | "destructive"[];
  /** What this is for, in the caller's own words. Recorded in the audit log, where the useful question months later is why, not what. */
  reason?: string;
  /** How long the grant survives without use. Idle time, not a lifetime — a grant being used every second does not expire mid-sentence. */
  seconds?: number;
}
export interface GrantScopeResult {
  /** Where this grant now hangs. Returned so a client can tell an anchor that was accepted from one that was quietly dropped. */
  anchors?: ScopeAnchor[];
  applications?: string[];
  /** How wide a net this scope casts. The competence dimension: breadth, not depth, is what overwhelms a small model. */
  breadth?: {
    /** Element-anchored permissions hung on this grant (A15). Each anchor is a separate place to keep track of, so it counts toward the same spread the applications do. */
    anchors: number;
    /** Distinct applications this grant spans. A weaker model loses track across many. */
    applications: number;
    /** True when the scope names no applications and neither does the ceiling, so it spans every application there is. The count above is then a floor, not a total. */
    unbounded: boolean;
  };
  /** The most this configuration will ever grant, returned whether or not the request needed all of it, so a client can tell 'not yet' from 'not ever' without asking twice. */
  ceiling: string[];
  /** Every criterion a commit under this grant will be judged against, the mechanical ones included whether or not they were asked for. Returned so a client can tell what review it has actually bought without inferring it from a refusal. */
  criteria?: string[];
  expiresInSeconds?: number;
  /** What this client now holds. Always includes observe: a client that may edit must be able to check whether its edit worked. */
  operationClasses: string[];
  /** How much damage a mistake within this scope can cause. A fact about the classes held, not an opinion about which model should hold them. */
  severity?: {
    /** True when the grant includes a class whose mistakes cannot be taken back (submit, destructive). */
    irreversible: boolean;
    /** Ordinal of the highest operation class held: observe=0, edit=1, activate=2, submit=3, destructive=4. */
    rank: number;
  };
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
  /** The identity this connection will be known by, issued by the service when the connection was accepted rather than taken from anything the client said. Grants, audit records and change attribution all key off it, so a client that wants to recognise its own actions in a delta should remember this and stop naming itself. A `clientId` sent in any request is kept only as a label. Absent from an older service, which still trusts the caller's own name. */
  clientId?: string;
  compatible: boolean;
  observationMode?: "active" | "idle";
  protocolVersion: string;
  /** The schema digest the running service was built from. Clients share one service instance with whoever attached first, so a client whose generated protocol is newer than the running daemon's would otherwise meet the difference as an unexplained METHOD_NOT_FOUND on a method its own types promise exists. Comparing this against its own digest lets a client say the daemon is older than it is, which is the actual problem. Optional so that an older service which never sends it stays compatible. */
  schemaDigest?: string;
  sessionToken: string;
  /** A minor difference is reported and allowed. A major mismatch fails the call instead of appearing here. */
  versionDifference: "none" | "minor";
}

/** Inspect the subtree below an element the caller has already located. The depth budget is measured from that element, not from the window, which is the only way to reach content that sits deeper than the maximum legal depth from a window root. (operation class: observe) */
export interface InspectElementParams {
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  /** How far below the anchor to walk. The same bound window inspection uses, and the same dependence on attention — drilling changes where a walk starts, never how far it may go. */
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
  /** True when the walk returned less than the subtree contains, whether it ran out of node budget or reached its depth limit. The elements it stopped at are marked, and are where inspectElement picks up. */
  truncated: boolean;
}

/** A compact, bounded semantic tree of one window, including the window's own actions. (operation class: observe) */
export interface InspectWindowParams {
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  /** How far below the window's frame to walk. What the service grants depends on the caller's attention: a connection watching the whole desktop is held to the shallow ceiling, one that has named applications may go as deep as it asks. Over-asking is clamped rather than refused, and the truncation marker says so. */
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
  /** True when the walk returned less than the subtree contains, whether it ran out of node budget or reached its depth limit. The elements it stopped at are marked, and are where inspectElement picks up. */
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

/** Start an installed application by its entry id. Takes an id from listInstallableApplications and nothing else — no command, no arguments, no path — for the same reason captureWindow takes a window id instead of coordinates: a method that accepts a string to execute is a shell, not a desktop. (operation class: activate) */
export interface LaunchApplicationParams {
  /** An id from listInstallableApplications. An id absent from that list is refused rather than attempted. */
  applicationEntryId: string;
  clientId?: string;
  confirm?: boolean;
  /** Quiet period the service waits for before reporting effects. A cold-starting application usually outlasts it; wait on window-opened rather than raising this. */
  settleMs?: number;
}
export type LaunchApplicationResult = ActionResult;

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
  /** Applications the display server can see and the accessibility layer cannot: they have windows open but no application on the accessibility bus, so nothing about them can be read or acted on. Reported so that an application which is running and unreadable is distinguishable from one that is not running. These rows carry no element ids and no window titles, because there is nothing to inspect and the title is the sensitive half of a window. */
  invisibleApplications?: {
    backend: string;
    /** What the display server or the kernel calls this application, since it has no accessible name to report. */
    name: string;
    pid: number;
    /** Why this application has no accessibility tree, and what would give it one. */
    reason: string;
    windowCount: number;
  }[];
  revision?: number;
}

/** The applications this desktop can start, as the desktop itself describes them. The only source of ids launchApplication will accept. (operation class: observe) */
export interface ListInstallableApplicationsParams {
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
}
export interface ListInstallableApplicationsResult {
  applications: {
    description?: string;
    /** The desktop entry id. An opaque handle to the caller: it names an application, it does not describe how to run one. */
    id: string;
    name: string;
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
    /** Which call this step is. Widened when typing arrived: focus a window and then type into it is the sequence somebody writing a message actually wants, and splitting it across two calls leaves a gap in which the desktop can change underneath the second one. */
    method: "focusWindow" | "invokeElement" | "setElementValue" | "typeText" | "typeKeystrokes" | "editText";
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

/** Find elements in a window by role, name or state. At least one filter is required. Optional ancestors/descendants/siblings expand the neighbourhood around each match after the match set is capped — how to find something in a large application without walking the whole tree. (operation class: observe) */
export interface QueryElementsParams {
  /** Expand each match upward toward the window root, returning up to this many ancestors in the element's ancestry field. Zero or absent means no ancestor expansion. Capped at 32 because a broken toolkit can hand back a non-terminating parent chain. */
  ancestors?: number;
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  /** Expand each match downward, populating the element's children field to this many depth levels. Zero or absent means no descendant expansion. */
  descendants?: number;
  limit?: number;
  name?: string;
  role?: string;
  /** When true, return each match's immediate neighbours (up to a per-hit cap) in the element's siblings field. */
  siblings?: boolean;
  states?: string[];
  windowId: string;
}
export interface QueryElementsResult {
  backend: string;
  elements: SemanticElement[];
  matchCount: number;
  /** More matches exist than were returned — either the search was cut short or the answer hit its limit with tree left unwalked. A caller seeing this should narrow its filter rather than assume it has seen everything. */
  moreResults?: boolean;
  /** Expansion was cut short by the node budget or time limit, not the search itself. Distinct from searchTruncated: the search covered the window, but some matches did not get their full neighbourhood. */
  neighbourhoodTruncated?: boolean;
  revision: number;
  /** The search gave up before covering the window. */
  searchTruncated: boolean;
}

/** Give a claimed element back before its lease runs out. Releasing what you do not hold is not an error: the desired state is that this client owns nothing here, and it is already true. A client that disconnects releases everything it held, because an element owned by a process that no longer exists is owned forever. (operation class: edit) */
export interface ReleaseElementParams {
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  elementId: string;
}
export interface ReleaseElementResult {
  heldForMs?: number;
  /** True when this call gave up a claim, false when there was nothing of this client's to give up. */
  released: boolean;
  revision: number;
}

/** Declare what this connection is looking at. Attention is not permission: it narrows what this one client is shown and how deep it may look, always inside what the consent ceiling already allows. It is per connection, so two agents on one service can watch different things. The call declares the whole attention — a field left out takes its default, and a call with no fields returns the connection to the whole desktop. (operation class: observe) */
export interface SetAttentionParams {
  /** Applications this connection cares about, by id or by name. Empty means the whole desktop, which is what an undeclared connection gets. */
  applications?: string[];
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  /** How far in to look. 'tree' lifts the depth ceiling on inspection, and only means anything once applications are named: the budget is affordable because the walk starts inside one application rather than at the desktop. */
  depth?: "surface" | "tree";
}
export interface SetAttentionResult {
  applications: string[];
  depth: "surface" | "tree";
  /** The depth ceiling now in force for this connection, so a client learns what its declaration bought rather than discovering it by truncation. */
  maxDepth: number;
  revision: number;
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

/** Declare intent to be told about changes to an element without holding a call open. A subscription is an observation claim, not a write claim: it does not prevent anyone else from acting on the element, and no subscription outranks the person at the keyboard. The element is resolved first — subscribing to an id that names nothing is an unkeepable promise. Subscribed elements are sampled on every observation sweep regardless of recency, because a declared intent outranks a heuristic that ranks by how recently something was touched. Over the per-connection ceiling is a refusal that names the ceiling, never a silent truncation: a service that accepts a thousand subscriptions and quietly samples the first sixteen has reinvented the current bug with better manners. A disconnecting client's subscriptions are all released, exactly as a claim is. (operation class: observe) */
export interface SubscribeElementParams {
  clientId?: string;
  confirm?: boolean;
  elementId: string;
}
export interface SubscribeElementResult {
  revision: number;
  subscribed: boolean;
}

/** Type into an element through synthetic keyboard events when the editable-text interface that typeText and setElementValue use is unavailable. The element is on the accessibility bus and its text can be read back, but it offers no way to write through it — a Discord composer, a browser input that only listens to key events. This is a deliberate escalation, not a fallback: the caller tried the accessible write and it refused, and the cost of typing at a window is that focus must be where the caller believes it is. Requires focus and reports which window it raised. Success is the field reading back what was typed, verified the same way as typeText. (operation class: edit) */
export interface TypeKeystrokesParams {
  clientId?: string;
  confirm?: boolean;
  elementId: string;
  /** Clear the field first by selecting all and deleting, since there is no editable-text interface to empty directly. Defaults to false, which appends. */
  replace?: boolean;
  settleMs?: number;
  /** What to type. Bounded for the same reason as typeText: the call is held open while it types, and a caller cannot wait forever. Characters outside printable Latin-1 are refused rather than typed as the wrong glyph. */
  text: string;
  /** Typing speed. Defaults to a competent typist. Unlike typeText this is not only presentation: keys arrive at an application one at a time through the X server, and an application that is busy drops the ones it was not ready for. */
  wordsPerMinute?: number;
}
export type TypeKeystrokesResult = ActionResult;

/** Put text into an editable element the way a person would: a word at a time, at a typist's speed, through the same editable-text interface dictation software uses. Prefer setElementValue for a form field nobody is watching; prefer this for anything a human will read as it arrives, and for applications that listen for edits rather than for their field being replaced. (operation class: edit) */
export interface TypeTextParams {
  clientId?: string;
  confirm?: boolean;
  elementId: string;
  /** Clear the field first. Defaults to false, which appends: extending a field is what typing does, and it leaves anything already there alone. */
  replace?: boolean;
  settleMs?: number;
  /** What to type. Bounded because the call is held open for as long as the typing takes, and a caller cannot wait forever. */
  text: string;
  /** Typing speed. Defaults to a competent typist. Faster than a person can type is available and is a choice the caller makes knowingly. */
  wordsPerMinute?: number;
}
export type TypeTextResult = ActionResult;

/** Stop asking to be told about an element. Releasing what you do not subscribe to is not an error: the desired state is that this client watches nothing here, and it is already true. A client that disconnects is unsubscribed from everything it held. (operation class: observe) */
export interface UnsubscribeElementParams {
  clientId?: string;
  /** Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. */
  confirm?: boolean;
  elementId: string;
}
export interface UnsubscribeElementResult {
  /** True when this call ended a subscription, false when there was nothing of this client's to give up. */
  released: boolean;
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

export type MethodName = "attestElement" | "auditTail" | "captureWindow" | "claimElement" | "commitElement" | "editText" | "emergencyStop" | "focusWindow" | "getDeltaSince" | "getDesktopCapabilities" | "getDesktopState" | "getElement" | "getRevision" | "grantScope" | "hello" | "inspectElement" | "inspectWindow" | "invokeElement" | "launchApplication" | "listApplications" | "listInstallableApplications" | "listWindows" | "performActions" | "queryElements" | "releaseElement" | "setAttention" | "setElementValue" | "setObservationMode" | "subscribeElement" | "typeKeystrokes" | "typeText" | "unsubscribeElement" | "waitFor";

export const OPERATION_CLASS: Record<MethodName, OperationClass> = {
  attestElement: "observe",
  auditTail: "observe",
  captureWindow: "observe",
  claimElement: "edit",
  commitElement: "destructive",
  editText: "edit",
  emergencyStop: "observe",
  focusWindow: "activate",
  getDeltaSince: "observe",
  getDesktopCapabilities: "observe",
  getDesktopState: "observe",
  getElement: "observe",
  getRevision: "observe",
  grantScope: "observe",
  hello: "observe",
  inspectElement: "observe",
  inspectWindow: "observe",
  invokeElement: "submit",
  launchApplication: "activate",
  listApplications: "observe",
  listInstallableApplications: "observe",
  listWindows: "observe",
  performActions: "submit",
  queryElements: "observe",
  releaseElement: "edit",
  setAttention: "observe",
  setElementValue: "edit",
  setObservationMode: "observe",
  subscribeElement: "observe",
  typeKeystrokes: "edit",
  typeText: "edit",
  unsubscribeElement: "observe",
  waitFor: "observe",
};

export interface MethodMap {
  attestElement: { params: AttestElementParams; result: AttestElementResult };
  auditTail: { params: AuditTailParams; result: AuditTailResult };
  captureWindow: { params: CaptureWindowParams; result: CaptureWindowResult };
  claimElement: { params: ClaimElementParams; result: ClaimElementResult };
  commitElement: { params: CommitElementParams; result: CommitElementResult };
  editText: { params: EditTextParams; result: EditTextResult };
  emergencyStop: { params: EmergencyStopParams; result: EmergencyStopResult };
  focusWindow: { params: FocusWindowParams; result: FocusWindowResult };
  getDeltaSince: { params: GetDeltaSinceParams; result: GetDeltaSinceResult };
  getDesktopCapabilities: { params: GetDesktopCapabilitiesParams; result: GetDesktopCapabilitiesResult };
  getDesktopState: { params: GetDesktopStateParams; result: GetDesktopStateResult };
  getElement: { params: GetElementParams; result: GetElementResult };
  getRevision: { params: GetRevisionParams; result: GetRevisionResult };
  grantScope: { params: GrantScopeParams; result: GrantScopeResult };
  hello: { params: HelloParams; result: HelloResult };
  inspectElement: { params: InspectElementParams; result: InspectElementResult };
  inspectWindow: { params: InspectWindowParams; result: InspectWindowResult };
  invokeElement: { params: InvokeElementParams; result: InvokeElementResult };
  launchApplication: { params: LaunchApplicationParams; result: LaunchApplicationResult };
  listApplications: { params: ListApplicationsParams; result: ListApplicationsResult };
  listInstallableApplications: { params: ListInstallableApplicationsParams; result: ListInstallableApplicationsResult };
  listWindows: { params: ListWindowsParams; result: ListWindowsResult };
  performActions: { params: PerformActionsParams; result: PerformActionsResult };
  queryElements: { params: QueryElementsParams; result: QueryElementsResult };
  releaseElement: { params: ReleaseElementParams; result: ReleaseElementResult };
  setAttention: { params: SetAttentionParams; result: SetAttentionResult };
  setElementValue: { params: SetElementValueParams; result: SetElementValueResult };
  setObservationMode: { params: SetObservationModeParams; result: SetObservationModeResult };
  subscribeElement: { params: SubscribeElementParams; result: SubscribeElementResult };
  typeKeystrokes: { params: TypeKeystrokesParams; result: TypeKeystrokesResult };
  typeText: { params: TypeTextParams; result: TypeTextResult };
  unsubscribeElement: { params: UnsubscribeElementParams; result: UnsubscribeElementResult };
  waitFor: { params: WaitForParams; result: WaitForResult };
}
