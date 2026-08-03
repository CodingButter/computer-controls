// Generated from protocol/schema.json — do not edit.
// Run: node scripts/generate-protocol.mjs
// Protocol version: 1.0   schema sha256: 9ffcc3f641ed0521

import { z } from "@mastra/code-sdk/plugin";

export const changeSchema = z.object({
  applicationId: z.string().optional(),
  applicationName: z.string().describe("The application this change happened in. Present because the identifier above is opaque, and a reader deciding whether a change concerns them should not have to look one up to find out.").optional(),
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
  code: z.enum(["APPLICATION_NOT_FOUND", "WINDOW_NOT_FOUND", "ELEMENT_NOT_FOUND", "ELEMENT_REFERENCE_STALE", "BACKEND_UNAVAILABLE", "ACTION_NOT_SUPPORTED", "PERMISSION_DENIED", "SESSION_EXPIRED", "ELEMENT_HELD", "TIMEOUT", "METHOD_NOT_FOUND", "INVALID_PARAMS", "INTERNAL_ERROR", "SUBSCRIPTION_LIMIT_REACHED"]),
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
  progress: z.record(z.string(), z.unknown()).describe("How far an action that takes real time actually got, present whether or not it succeeded. An action interrupted partway has still changed the desktop, so a deadline or a stalled application is reported here rather than raised: the caller reads how much landed, decides whether waiting is still reasonable, and acts on the state instead of on the absence of an answer.").optional(),
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

export const elementClaimSchema = z.object({
  clientId: z.string().describe("The issued identity holding the claim, never a name a client chose for itself."),
  clientLabel: z.string().describe("The holder's readable label, for telling a person who is in their field.").optional(),
  elementId: z.string(),
  expiresInMs: z.number().int().min(0).describe("Time left on the lease, as of this answer."),
  heldForMs: z.number().int().min(0),
  leaseMs: z.number().int().min(0).describe("The lease as granted, so a caller can tell a long claim from an old one."),
  reason: z.string().describe("What the holder said it was doing. Present when it said.").optional(),
});

export const semanticElementSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    actions: z.array(z.string()).describe("Action names invokable on this element. For a window this is often the application's whole command set."),
    ancestry: z.array(semanticElementSchema).describe("Ancestor chain for this element, nearest first, up to the requested depth. Present only when the caller asked for ancestor expansion. Each entry is a full element whose id is valid for getElement.").optional(),
    backend: z.enum(["atspi", "compositor"]),
    bounds: boundsSchema.optional(),
    children: z.array(semanticElementSchema).optional(),
    extra: z.record(z.string(), z.unknown()).describe("Backend-specific detail that does not fit the common model, namespaced by backend. Present so richer backends are not flattened to a lowest common denominator.").optional(),
    id: z.string().regex(/^(el|win|app)-[0-9a-f]{12}$/).describe("Stable reference. Valid for the service instance's lifetime. Never reused for a different element."),
    name: z.string().describe("Accessible name. Passed through the value-egress point."),
    role: z.string().describe("What kind of thing it is, in the backend's vocabulary."),
    siblings: z.array(semanticElementSchema).describe("Immediate neighbours of this element under the same parent, up to a per-hit cap. Present only when the caller asked for sibling expansion.").optional(),
    states: z.array(z.string()),
    truncated: z.boolean().describe("Present and true when this element has children the walk did not return, whether because the node budget ran out or because the depth limit was reached. Never silently omitted: a subtree that was cut off must never be indistinguishable from one that ended. Drill from this element with inspectElement to see what is below it.").optional(),
    value: z.string().describe("Current value, for elements that hold one. Passed through the value-egress point.").optional(),
  }),
);

export const attestElementParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().optional(),
  elementId: z.string().describe("The field whose contents are being attested for a later commit."),
});
export const attestElementResult = z.object({
  attestationId: z.string().describe("Identifies this attestation. Present it to commitElement within its TTL; one attestation admits exactly one commit."),
  expiresInMs: z.number().int().min(0).describe("How long before the attestation must be retaken. A stale attestation is not reusable."),
});

export const auditTailParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export const auditTailResult = z.object({
  entries: z.array(z.record(z.string(), z.unknown())),
  path: z.string(),
  writeFailures: z.number().int().describe("Records this service could not write. Non-zero means the log is incomplete, which a reader has to be told rather than left to infer from a gap.").optional(),
  written: z.number().int().optional(),
});

export const captureWindowParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  maxWidth: z.number().int().min(64).max(4096).describe("Scale the image down to at most this width. Only ever downward: enlarging a capture invents detail that was never captured.").optional(),
  windowId: z.string(),
});
export const captureWindowResult = z.object({
  backend: z.string(),
  capturedHeight: z.number().int().optional(),
  capturedWidth: z.number().int().describe("Width before the invisible client-side-decoration margin was cropped away. Differs from width on GTK windows, which reserve room for their own drop shadow.").optional(),
  format: z.enum(["png"]),
  frameCropped: z.boolean().optional(),
  height: z.number().int(),
  image: z.string().describe("The image itself, base64-encoded, so a capture travels over any transport this protocol is carried on rather than only over one with a shared filesystem."),
  revision: z.number().int(),
  scaled: z.boolean().optional(),
  width: z.number().int(),
  windowId: z.string(),
});

export const claimElementParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().optional(),
  elementId: z.string(),
  estimatedWorkMs: z.number().int().min(1).max(600000).describe("How long the caller believes its work will take. The lease is this plus a settling margin. Bounded, because a lease nobody can outlive is ownership wearing a lease's name.").optional(),
  forText: z.string().max(4000).describe("Instead of an estimate: the text about to be typed. The service sizes the lease from it at the words-per-minute given, using the arithmetic the typing will use.").optional(),
  reason: z.string().max(200).describe("What this claim is for, in the caller's words. Shown to whoever is refused, and recorded in the audit log.").optional(),
  wordsPerMinute: z.number().int().min(10).max(220).optional(),
});
export const claimElementResult = z.object({
  claim: elementClaimSchema,
  revision: z.number().int().min(0),
});

export const commitElementParams = z.object({
  action: z.string().describe("The action to trigger, as reported in the element's actions list. Not an index: indices move. When omitted, the element's first action is used.").optional(),
  attestationId: z.string().describe("The attestation returned by attestElement for this field. One attestation admits one commit; a second commit with the same id is refused."),
  clientId: z.string().optional(),
  confirm: z.boolean().optional(),
  elementId: z.string().describe("The field whose attested contents are being sent."),
  settleMs: z.number().int().min(0).max(10000).optional(),
});
export const commitElementResult = z.record(z.string(), z.unknown());

export const editTextParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().optional(),
  elementId: z.string(),
  find: z.string().max(4000).describe("The existing text to replace. Must appear exactly once: two matches mean the caller does not know which one it meant, and the edit is refused rather than guessed."),
  replaceWith: z.string().max(4000).describe("What to put in its place. Omit to delete the range outright.").optional(),
  settleMs: z.number().int().min(0).max(10000).optional(),
  showSelection: z.boolean().describe("Highlight the range before removing it, so a watching human sees what changed. Presentation only: the edit does not need it.").optional(),
  wordsPerMinute: z.number().int().min(10).max(220).describe("When present the replacement is typed at this speed rather than inserted at once, for an edit a person is watching.").optional(),
});
export const editTextResult = z.record(z.string(), z.unknown());

export const emergencyStopParams = z.object({
  clear: z.boolean().describe("Lift a stop rather than raise one. Separate and deliberate: a stop that any subsequent call could clear as a side effect would be a suggestion.").optional(),
  clientId: z.string().optional(),
  confirm: z.boolean().optional(),
  reason: z.string().max(400).optional(),
});
export const emergencyStopResult = z.object({
  grantsRevoked: z.number().int(),
  inFlight: z.number().int().describe("Actions already dispatched when the stop landed. These are the ones nobody can call back.").optional(),
  stopped: z.boolean(),
});

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

export const grantScopeParams = z.object({
  applications: z.array(z.string().max(200)).describe("Application names this grant covers, matched as substrings of the application's own name. Omit for every application the configuration allows. Never matched against window titles: a title is text the user typed, and a boundary drawn on it can be moved by typing.").optional(),
  clientId: z.string().optional(),
  confirm: z.boolean().optional(),
  operationClasses: z.array(z.enum(["observe", "edit", "activate", "submit", "destructive"])).describe("What this client intends to do. Ask for what the task needs and no more: a grant is also a description of the blast radius in the audit log."),
  reason: z.string().max(400).describe("What this is for, in the caller's own words. Recorded in the audit log, where the useful question months later is why, not what.").optional(),
  seconds: z.number().int().min(30).max(86400).describe("How long the grant survives without use. Idle time, not a lifetime — a grant being used every second does not expire mid-sentence.").optional(),
});
export const grantScopeResult = z.object({
  applications: z.array(z.string()).optional(),
  ceiling: z.array(z.string()).describe("The most this configuration will ever grant, returned whether or not the request needed all of it, so a client can tell 'not yet' from 'not ever' without asking twice."),
  expiresInSeconds: z.number().int().optional(),
  operationClasses: z.array(z.string()).describe("What this client now holds. Always includes observe: a client that may edit must be able to check whether its edit worked."),
});

export const helloParams = z.object({
  clientId: z.string().optional(),
  clientName: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  protocolVersion: z.string().regex(/^[0-9]+\.[0-9]+$/),
});
export const helloResult = z.object({
  clientId: z.string().describe("The identity this connection will be known by, issued by the service when the connection was accepted rather than taken from anything the client said. Grants, audit records and change attribution all key off it, so a client that wants to recognise its own actions in a delta should remember this and stop naming itself. A `clientId` sent in any request is kept only as a label. Absent from an older service, which still trusts the caller's own name.").optional(),
  compatible: z.boolean(),
  observationMode: z.enum(["active", "idle"]).optional(),
  protocolVersion: z.string(),
  schemaDigest: z.string().describe("The schema digest the running service was built from. Clients share one service instance with whoever attached first, so a client whose generated protocol is newer than the running daemon's would otherwise meet the difference as an unexplained METHOD_NOT_FOUND on a method its own types promise exists. Comparing this against its own digest lets a client say the daemon is older than it is, which is the actual problem. Optional so that an older service which never sends it stays compatible.").optional(),
  sessionToken: z.string(),
  versionDifference: z.enum(["none", "minor"]).describe("A minor difference is reported and allowed. A major mismatch fails the call instead of appearing here."),
});

export const inspectElementParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  depth: z.number().int().min(1).max(64).describe("How far below the anchor to walk. The same bound window inspection uses, and the same dependence on attention — drilling changes where a walk starts, never how far it may go.").optional(),
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
  truncated: z.boolean().describe("True when the walk returned less than the subtree contains, whether it ran out of node budget or reached its depth limit. The elements it stopped at are marked, and are where inspectElement picks up."),
});

export const inspectWindowParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  depth: z.number().int().min(1).max(64).describe("How far below the window's frame to walk. What the service grants depends on the caller's attention: a connection watching the whole desktop is held to the shallow ceiling, one that has named applications may go as deep as it asks. Over-asking is clamped rather than refused, and the truncation marker says so.").optional(),
  excludeRoles: z.array(z.string()).optional(),
  includeRoles: z.array(z.string()).optional(),
  maxNodes: z.number().int().min(1).max(1000).optional(),
  windowId: z.string(),
});
export const inspectWindowResult = z.object({
  backend: z.string(),
  nodeCount: z.number().int(),
  revision: z.number().int(),
  truncated: z.boolean().describe("True when the walk returned less than the subtree contains, whether it ran out of node budget or reached its depth limit. The elements it stopped at are marked, and are where inspectElement picks up."),
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

export const launchApplicationParams = z.object({
  applicationEntryId: z.string().describe("An id from listInstallableApplications. An id absent from that list is refused rather than attempted."),
  clientId: z.string().optional(),
  confirm: z.boolean().optional(),
  settleMs: z.number().int().min(0).max(10000).describe("Quiet period the service waits for before reporting effects. A cold-starting application usually outlasts it; wait on window-opened rather than raising this.").optional(),
});
export const launchApplicationResult = z.record(z.string(), z.unknown());

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

export const listInstallableApplicationsParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
});
export const listInstallableApplicationsResult = z.object({
  applications: z.array(z.object({
    description: z.string().optional(),
    id: z.string().describe("The desktop entry id. An opaque handle to the caller: it names an application, it does not describe how to run one."),
    name: z.string(),
  })),
  backend: z.string(),
  revision: z.number().int().min(0).optional(),
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
    method: z.enum(["focusWindow", "invokeElement", "setElementValue", "typeText", "editText"]).describe("Which call this step is. Widened when typing arrived: focus a window and then type into it is the sequence somebody writing a message actually wants, and splitting it across two calls leaves a gap in which the desktop can change underneath the second one."),
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
  ancestors: z.number().int().min(0).max(32).describe("Expand each match upward toward the window root, returning up to this many ancestors in the element's ancestry field. Zero or absent means no ancestor expansion. Capped at 32 because a broken toolkit can hand back a non-terminating parent chain.").optional(),
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  descendants: z.number().int().min(0).max(10).describe("Expand each match downward, populating the element's children field to this many depth levels. Zero or absent means no descendant expansion.").optional(),
  limit: z.number().int().min(1).max(200).optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  siblings: z.boolean().describe("When true, return each match's immediate neighbours (up to a per-hit cap) in the element's siblings field.").optional(),
  states: z.array(z.string()).optional(),
  windowId: z.string(),
}).refine((value) => value.role !== undefined || value.name !== undefined || value.states !== undefined, { message: "at least one of role, name, states is required" });
export const queryElementsResult = z.object({
  backend: z.string(),
  elements: z.array(semanticElementSchema),
  matchCount: z.number().int(),
  moreResults: z.boolean().describe("More matches exist than were returned — either the search was cut short or the answer hit its limit with tree left unwalked. A caller seeing this should narrow its filter rather than assume it has seen everything.").optional(),
  neighbourhoodTruncated: z.boolean().describe("Expansion was cut short by the node budget or time limit, not the search itself. Distinct from searchTruncated: the search covered the window, but some matches did not get their full neighbourhood.").optional(),
  revision: z.number().int(),
  searchTruncated: z.boolean().describe("The search gave up before covering the window."),
});

export const releaseElementParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  elementId: z.string(),
});
export const releaseElementResult = z.object({
  heldForMs: z.number().int().min(0).optional(),
  released: z.boolean().describe("True when this call gave up a claim, false when there was nothing of this client's to give up."),
  revision: z.number().int().min(0),
});

export const setAttentionParams = z.object({
  applications: z.array(z.string().max(128)).describe("Applications this connection cares about, by id or by name. Empty means the whole desktop, which is what an undeclared connection gets.").optional(),
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  depth: z.enum(["surface", "tree"]).describe("How far in to look. 'tree' lifts the depth ceiling on inspection, and only means anything once applications are named: the budget is affordable because the walk starts inside one application rather than at the desktop.").optional(),
});
export const setAttentionResult = z.object({
  applications: z.array(z.string()),
  depth: z.enum(["surface", "tree"]),
  maxDepth: z.number().int().describe("The depth ceiling now in force for this connection, so a client learns what its declaration bought rather than discovering it by truncation."),
  revision: z.number().int(),
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

export const subscribeElementParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().optional(),
  elementId: z.string(),
});
export const subscribeElementResult = z.object({
  revision: z.number().int().min(0),
  subscribed: z.boolean(),
});

export const typeTextParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().optional(),
  elementId: z.string(),
  replace: z.boolean().describe("Clear the field first. Defaults to false, which appends: extending a field is what typing does, and it leaves anything already there alone.").optional(),
  settleMs: z.number().int().min(0).max(10000).optional(),
  text: z.string().max(4000).describe("What to type. Bounded because the call is held open for as long as the typing takes, and a caller cannot wait forever."),
  wordsPerMinute: z.number().int().min(10).max(220).describe("Typing speed. Defaults to a competent typist. Faster than a person can type is available and is a choice the caller makes knowingly.").optional(),
});
export const typeTextResult = z.record(z.string(), z.unknown());

export const unsubscribeElementParams = z.object({
  clientId: z.string().optional(),
  confirm: z.boolean().describe("Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.").optional(),
  elementId: z.string(),
});
export const unsubscribeElementResult = z.object({
  released: z.boolean().describe("True when this call ended a subscription, false when there was nothing of this client's to give up."),
  revision: z.number().int().min(0),
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
