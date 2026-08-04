# Tool API

Generated from `protocol/schema.json` — do not edit.
Run: `node scripts/generate-tool-api-doc.mjs`
Protocol version: 1.0   schema sha256: df835e41b95f379e

The contract between any client and the desktop service. Frozen at 1.0. Additive changes only: new methods and new optional fields. Removing a method, renaming or removing a field, narrowing a type, changing an error code, or adding a required request field is a breaking change and requires a major version.

## Operation classes

What a method does to the world. Declared here at freeze time so enforcement can be added later without changing any request shape.

| Class | What it does |
|---|---|
| `observe` | Reads desktop state. Changes nothing. |
| `edit` | Changes a value in place, such as typing into a field. |
| `activate` | Moves focus or raises a window. Visible to the user, trivially reversible. |
| `submit` | Triggers an application's own action. Consequences belong to the application. |
| `destructive` | May discard or overwrite user data, or is not reversible. |

## Methods (33)

### `attestElement`

**Operation class:** `observe`

Read and record what is in a field right now, so a later commitElement can refuse if it has changed. The evidence is the field's own contents read by the service — the caller writes the argument (which element), never the evidence (what text). A masked field, whose contents even the accessibility layer cannot read, is refused: there is nothing to attest that a later commit could compare against. Composing is not sending, and this call authorises nothing: it takes a snapshot, and the snapshot is only as good as the moment it was taken.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no |  |
| `elementId` | string | yes | The field whose contents are being attested for a later commit. |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `attestationId` | string | yes | Identifies this attestation. Present it to commitElement within its TTL; one attestation admits exactly one commit. |
| `expiresInMs` | integer | yes | How long before the attestation must be retaken. A stale attestation is not reusable. |

---

### `auditTail`

**Operation class:** `observe`

The most recent entries from this service's audit log, including the calls that were refused. Refusals are the half worth reading: an agent that tried to close a window and was told no is a fact about the agent, and it is invisible in a record of what succeeded. Entries carry what was done and to which application, never the contents of anything read or typed.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |
| `limit` | integer | no |  |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `entries` | object[] | yes |  |
| `path` | string | yes |  |
| `writeFailures` | integer | no | Records this service could not write. Non-zero means the log is incomplete, which a reader has to be told rather than left to infer from a gap. |
| `written` | integer | no |  |

---

### `captureWindow`

**Operation class:** `observe`

The pixels of one window, for content the accessibility layer cannot express — what an image shows, what a canvas drew. Takes a window id and never a screen region, so only that window is ever in frame and the addressing model gains no second, weaker form. Look at the picture; still act through element references.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |
| `maxWidth` | integer | no | Scale the image down to at most this width. Only ever downward: enlarging a capture invents detail that was never captured. |
| `windowId` | string | yes |  |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `backend` | string | yes |  |
| `capturedHeight` | integer | no |  |
| `capturedWidth` | integer | no | Width before the invisible client-side-decoration margin was cropped away. Differs from width on GTK windows, which reserve room for their own drop shadow. |
| `format` | `png` | yes |  |
| `frameCropped` | boolean | no |  |
| `height` | integer | yes |  |
| `image` | string | yes | The image itself, base64-encoded, so a capture travels over any transport this protocol is carried on rather than only over one with a shared filesystem. |
| `revision` | integer | yes |  |
| `scaled` | boolean | no |  |
| `width` | integer | yes |  |
| `windowId` | string | yes |  |

---

### `claimElement`

**Operation class:** `edit`

Take exclusive write ownership of one element for a bounded time, across as many calls as the work takes. No write is ever unowned — a write with no claim behind it takes one for its own duration and gives it back — so this is not a step to be added before every typeText. It is what closes the gap between two calls a caller thinks of as one piece of work: read the field, decide, type, check, type again. A claimed element cannot be taken by anyone else until it is released or its lease runs out — there is no preemption by a second agent, because the thing being protected is a sentence that is only half typed. The lease is sized by the work rather than by a house number: give estimatedWorkMs, or give the text about to be typed and let the service compute it with the same cadence arithmetic the typing itself uses, so the estimate and the work cannot drift apart. A lease is capped at ten minutes however long the work is, so work longer than that is claimed again as it goes; and a lease never ends in the middle of a write it is covering, because it exists to bound how long an element is held between calls rather than to interrupt one. A claim that has run out by the time the next write arrives is the caller having estimated badly, which it is told once, by name, rather than discovering later as somebody else's refusal. The person at the keyboard is not a client and holds no claim; their arrival still ends any write in the field they touch, and no claim outranks that.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no |  |
| `elementId` | string | yes |  |
| `estimatedWorkMs` | integer | no | How long the caller believes its work will take. The lease is this plus a settling margin. Bounded, because a lease nobody can outlive is ownership wearing a lease's name. |
| `forText` | string | no | Instead of an estimate: the text about to be typed. The service sizes the lease from it at the words-per-minute given, using the arithmetic the typing will use. |
| `reason` | string | no | What this claim is for, in the caller's words. Shown to whoever is refused, and recorded in the audit log. |
| `wordsPerMinute` | integer | no |  |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `claim` | [`elementClaim`](#elementclaim) | yes |  |
| `revision` | integer | yes |  |

---

### `commitElement`

**Operation class:** `destructive`

Send what was attested. Re-reads the field and refuses if it no longer matches what attestElement recorded; if it matches, triggers the element's own action. Success is asserted from the observed effect — the field is now empty, meaning it transmitted — not from the action call returning true. A field that the action was called on but which still contains its contents afterwards is a commit that did not send, reported as failure regardless of what the action call returned. The thing that would have caught the original incident: a keystroke that typed a character instead of pressing Return leaves the field non-empty, and that is the failure this reports.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | no | The action to trigger, as reported in the element's actions list. Not an index: indices move. When omitted, the element's first action is used. |
| `attestationId` | string | yes | The attestation returned by attestElement for this field. One attestation admits one commit; a second commit with the same id is refused. |
| `clientId` | string | no |  |
| `confirm` | boolean | no |  |
| `elementId` | string | yes | The field whose attested contents are being sent. |
| `settleMs` | integer | no |  |

**Result:** [`actionResult`](#actionresult)

---

### `editText`

**Operation class:** `edit`

Replace or remove part of an editable element's text, addressed by the text itself rather than by character offsets. Editing at this layer is a splice — a range is removed and something is put in its place in one operation — because there is no keyboard here and nothing to press backspace on. An offset computed from a field somebody has since typed into points at the wrong characters; text that has moved is simply not found, which is a refusal instead of a wrong edit.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no |  |
| `elementId` | string | yes |  |
| `find` | string | yes | The existing text to replace. Must appear exactly once: two matches mean the caller does not know which one it meant, and the edit is refused rather than guessed. |
| `replaceWith` | string | no | What to put in its place. Omit to delete the range outright. |
| `settleMs` | integer | no |  |
| `showSelection` | boolean | no | Highlight the range before removing it, so a watching human sees what changed. Presentation only: the edit does not need it. |
| `wordsPerMinute` | integer | no | When present the replacement is typed at this speed rather than inserted at once, for an edit a person is watching. |

**Result:** [`actionResult`](#actionresult)

---

### `emergencyStop`

**Operation class:** `observe`

Revoke every grant on this service and refuse everything but observation until it is deliberately cleared. It does not time out. What it cannot do is take back an action already handed to a toolkit: there is no un-click, and a stop that implied otherwise would be worse than none, because somebody would rely on it. Classified as observe so that a client with no grant left can still pull it.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clear` | boolean | no | Lift a stop rather than raise one. Separate and deliberate: a stop that any subsequent call could clear as a side effect would be a suggestion. |
| `clientId` | string | no |  |
| `confirm` | boolean | no |  |
| `reason` | string | no |  |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `grantsRevoked` | integer | yes |  |
| `inFlight` | integer | no | Actions already dispatched when the stop landed. These are the ones nobody can call back. |
| `stopped` | boolean | yes |  |

---

### `focusWindow`

**Operation class:** `activate`

Raise and focus a window by id. Addressed semantically; no coordinates on either path.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no |  |
| `settleMs` | integer | no | Quiet period the service waits for before reporting effects. The ceiling is protocol-visible rather than a magic number in the code. |
| `windowId` | string | yes |  |

**Result:** [`actionResult`](#actionresult)

---

### `getDeltaSince`

**Operation class:** `observe`

Everything that changed since a revision the caller already knows about, attributed for this caller. The same engine answers this and pushes unsolicited deltas, so a caller that polls and a caller that listens are never told different stories about one desktop.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no | Who is asking. Attribution is computed for this caller: the same change reads as 'self' to the client that caused it and 'external' to everyone else. |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |
| `sinceRevision` | integer | yes | The last revision this caller has seen. Changes at or below it are not repeated. |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `changes` | [`change`](#change)[] | yes |  |
| `complete` | boolean | yes | False when the caller fell so far behind that the oldest changes it missed are no longer held. An incomplete answer that looked complete would be a lie that reads like calm: a caller told false should re-read rather than assume the quiet was real. |
| `resumeRevision` | integer | no | Present when complete is false: the earliest cursor that still yields everything the service holds. Pass it as sinceRevision to resume without a gap. It is a cursor, not the oldest surviving change — sinceRevision is exclusive, so returning the oldest surviving revision would make the caller skip it. |
| `revision` | integer | yes |  |

---

### `getDesktopCapabilities`

**Operation class:** `observe`

What this session can and cannot do, probed rather than assumed.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no | Which client is asking. Multiple clients share one service instance and one element namespace; this is for audit and scope, not for addressing. |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `observationMode` | `active` \| `idle` | no |  |
| `recommendedBackends` | string[] | yes |  |
| `session` | object | yes |  |
| `tiers` | [`capabilityTierReport`](#capabilitytierreport)[] | yes |  |

---

### `getDesktopState`

**Operation class:** `observe`

The current picture in one call: which windows exist and which one has focus. What a caller reads to re-acquire the desktop after being told its delta was incomplete.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `activeWindowId` | string | yes | Empty when nothing on this desktop holds focus, which is a real state and not an error. |
| `observationMode` | `active` \| `idle` | no |  |
| `revision` | integer | yes |  |
| `windows` | object[] | yes |  |

---

### `getElement`

**Operation class:** `observe`

Re-describe one element by id. Raises ELEMENT_REFERENCE_STALE rather than substituting a similar element.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |
| `elementId` | string | yes |  |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `backend` | string | yes |  |
| `element` | [`semanticElement`](#semanticelement) | yes |  |
| `revision` | integer | yes |  |

---

### `getRevision`

**Operation class:** `observe`

The session's current revision. The addressing unit for deltas and causal attribution.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `observationMode` | `active` \| `idle` | no |  |
| `revision` | integer | yes |  |

---

### `grantScope`

**Operation class:** `observe`

Ask for the operation classes this client may use, within the ceiling the user's configuration sets. Only ever narrows: a request above the ceiling is refused by naming the config key, because the answer to 'why can't I' should be a file the user owns rather than a shrug. Classified as observe so that a client holding nothing can still ask — refusing the request for permission is not a security boundary, it is a dead end.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `anchors` | [`scopeAnchor`](#scopeanchor)[] | no | Places in the tree this grant hangs on, instead of hanging on whole applications. A grant that names anchors has said where it applies, so anywhere else is outside it — the same rule naming applications individually has always had. Omit to grant across applications as before. |
| `applications` | string[] | no | Application names this grant covers, matched as substrings of the application's own name. Omit for every application the configuration allows. Never matched against window titles: a title is text the user typed, and a boundary drawn on it can be moved by typing. |
| `clientId` | string | no |  |
| `confirm` | boolean | no |  |
| `criteria` | string[] | no | The questions a commit made under this grant must be answered against. Declared here, at the door, because the party being graded does not write the rubric — a worker cannot reach this field, and the service's own mechanical criteria are asked on top of whatever is named here. A name this service cannot decide is still carried and reported as unchecked, so that asking for review is never worse than asking for nothing. |
| `operationClasses` | `observe` \| `edit` \| `activate` \| `submit` \| `destructive`[] | yes | What this client intends to do. Ask for what the task needs and no more: a grant is also a description of the blast radius in the audit log. |
| `reason` | string | no | What this is for, in the caller's own words. Recorded in the audit log, where the useful question months later is why, not what. |
| `seconds` | integer | no | How long the grant survives without use. Idle time, not a lifetime — a grant being used every second does not expire mid-sentence. |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `anchors` | [`scopeAnchor`](#scopeanchor)[] | no | Where this grant now hangs. Returned so a client can tell an anchor that was accepted from one that was quietly dropped. |
| `applications` | string[] | no |  |
| `breadth` | object | no | How wide a net this scope casts. The competence dimension: breadth, not depth, is what overwhelms a small model. |
| `ceiling` | string[] | yes | The most this configuration will ever grant, returned whether or not the request needed all of it, so a client can tell 'not yet' from 'not ever' without asking twice. |
| `criteria` | string[] | no | Every criterion a commit under this grant will be judged against, the mechanical ones included whether or not they were asked for. Returned so a client can tell what review it has actually bought without inferring it from a refusal. |
| `expiresInSeconds` | integer | no |  |
| `operationClasses` | string[] | yes | What this client now holds. Always includes observe: a client that may edit must be able to check whether its edit worked. |
| `severity` | object | no | How much damage a mistake within this scope can cause. A fact about the classes held, not an opinion about which model should hold them. |

---

### `hello`

**Operation class:** `observe`

Version handshake. First call on a connection.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `clientName` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |
| `protocolVersion` | string | yes |  |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no | The identity this connection will be known by, issued by the service when the connection was accepted rather than taken from anything the client said. Grants, audit records and change attribution all key off it, so a client that wants to recognise its own actions in a delta should remember this and stop naming itself. A `clientId` sent in any request is kept only as a label. Absent from an older service, which still trusts the caller's own name. |
| `compatible` | boolean | yes |  |
| `observationMode` | `active` \| `idle` | no |  |
| `protocolVersion` | string | yes |  |
| `schemaDigest` | string | no | The schema digest the running service was built from. Clients share one service instance with whoever attached first, so a client whose generated protocol is newer than the running daemon's would otherwise meet the difference as an unexplained METHOD_NOT_FOUND on a method its own types promise exists. Comparing this against its own digest lets a client say the daemon is older than it is, which is the actual problem. Optional so that an older service which never sends it stays compatible. |
| `sessionToken` | string | yes |  |
| `versionDifference` | `none` \| `minor` | yes | A minor difference is reported and allowed. A major mismatch fails the call instead of appearing here. |

---

### `inspectElement`

**Operation class:** `observe`

Inspect the subtree below an element the caller has already located. The depth budget is measured from that element, not from the window, which is the only way to reach content that sits deeper than the maximum legal depth from a window root.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |
| `depth` | integer | no | How far below the anchor to walk. The same bound window inspection uses, and the same dependence on attention — drilling changes where a walk starts, never how far it may go. |
| `elementId` | string | yes | Where the walk starts. Must come from an earlier inspection or query: there is no way to drill into something the caller has not already seen and chosen. |
| `excludeRoles` | string[] | no |  |
| `includeRoles` | string[] | no |  |
| `maxNodes` | integer | no |  |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `backend` | string | yes |  |
| `element` | [`semanticElement`](#semanticelement) | yes |  |
| `nodeCount` | integer | yes |  |
| `revision` | integer | yes |  |
| `truncated` | boolean | yes | True when the walk returned less than the subtree contains, whether it ran out of node budget or reached its depth limit. The elements it stopped at are marked, and are where inspectElement picks up. |

---

### `inspectWindow`

**Operation class:** `observe`

A compact, bounded semantic tree of one window, including the window's own actions.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |
| `depth` | integer | no | How far below the window's frame to walk. What the service grants depends on the caller's attention: a connection watching the whole desktop is held to the shallow ceiling, one that has named applications may go as deep as it asks. Over-asking is clamped rather than refused, and the truncation marker says so. |
| `excludeRoles` | string[] | no |  |
| `includeRoles` | string[] | no |  |
| `maxNodes` | integer | no |  |
| `windowId` | string | yes |  |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `backend` | string | yes |  |
| `nodeCount` | integer | yes |  |
| `revision` | integer | yes |  |
| `truncated` | boolean | yes | True when the walk returned less than the subtree contains, whether it ran out of node budget or reached its depth limit. The elements it stopped at are marked, and are where inspectElement picks up. |
| `window` | [`semanticElement`](#semanticelement) | yes |  |

---

### `invokeElement`

**Operation class:** `submit`

Invoke a named action an element or window frame exposes. Frame actions are first class: a GTK4 window can expose dozens of them while its element tree is nearly empty.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | yes | The action's own name, as reported in the element's actions list. Not an index: indices move. |
| `clientId` | string | no |  |
| `confirm` | boolean | no |  |
| `elementId` | string | yes |  |
| `settleMs` | integer | no |  |

**Result:** [`actionResult`](#actionresult)

---

### `launchApplication`

**Operation class:** `activate`

Start an installed application by its entry id. Takes an id from listInstallableApplications and nothing else — no command, no arguments, no path — for the same reason captureWindow takes a window id instead of coordinates: a method that accepts a string to execute is a shell, not a desktop.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `applicationEntryId` | string | yes | An id from listInstallableApplications. An id absent from that list is refused rather than attempted. |
| `clientId` | string | no |  |
| `confirm` | boolean | no |  |
| `settleMs` | integer | no | Quiet period the service waits for before reporting effects. A cold-starting application usually outlasts it; wait on window-opened rather than raising this. |

**Result:** [`actionResult`](#actionresult)

---

### `listApplications`

**Operation class:** `observe`

Applications currently running on the desktop.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `applications` | object[] | yes |  |
| `backend` | string | yes |  |
| `invisibleApplications` | object[] | no | Applications the display server can see and the accessibility layer cannot: they have windows open but no application on the accessibility bus, so nothing about them can be read or acted on. Reported so that an application which is running and unreadable is distinguishable from one that is not running. These rows carry no element ids and no window titles, because there is nothing to inspect and the title is the sensitive half of a window. |
| `revision` | integer | no |  |

---

### `listInstallableApplications`

**Operation class:** `observe`

The applications this desktop can start, as the desktop itself describes them. The only source of ids launchApplication will accept.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `applications` | object[] | yes |  |
| `backend` | string | yes |  |
| `revision` | integer | no |  |

---

### `listWindows`

**Operation class:** `observe`

Top-level windows, optionally narrowed to one application.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `applicationId` | string | no |  |
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `backend` | string | yes |  |
| `revision` | integer | no |  |
| `windows` | object[] | yes |  |

---

### `performActions`

**Operation class:** `submit`

Run a sequence of actions in one round trip. The token-efficiency lever: a sequence costs one exchange rather than one per step.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `actions` | object[] | yes |  |
| `clientId` | string | no |  |
| `confirm` | boolean | no |  |
| `stopOnFailure` | boolean | no | When true the batch halts at the first failure and reports which actions ran. Defaults to true: continuing a sequence past a step that did not happen is rarely what anyone wants. |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `completed` | integer | yes | How many of the requested actions ran. Less than the number requested means the batch stopped early. |
| `results` | [`actionResult`](#actionresult)[] | yes |  |
| `revision` | integer | yes |  |

---

### `queryElements`

**Operation class:** `observe`

Find elements in a window by role, name or state. At least one filter is required. Optional ancestors/descendants/siblings expand the neighbourhood around each match after the match set is capped — how to find something in a large application without walking the whole tree.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `ancestors` | integer | no | Expand each match upward toward the window root, returning up to this many ancestors in the element's ancestry field. Zero or absent means no ancestor expansion. Capped at 32 because a broken toolkit can hand back a non-terminating parent chain. |
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |
| `descendants` | integer | no | Expand each match downward, populating the element's children field to this many depth levels. Zero or absent means no descendant expansion. |
| `limit` | integer | no |  |
| `name` | string | no |  |
| `role` | string | no |  |
| `siblings` | boolean | no | When true, return each match's immediate neighbours (up to a per-hit cap) in the element's siblings field. |
| `states` | string[] | no |  |
| `windowId` | string | yes |  |

At least one of `role`, `name`, `states` is required.

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `backend` | string | yes |  |
| `elements` | [`semanticElement`](#semanticelement)[] | yes |  |
| `matchCount` | integer | yes |  |
| `moreResults` | boolean | no | More matches exist than were returned — either the search was cut short or the answer hit its limit with tree left unwalked. A caller seeing this should narrow its filter rather than assume it has seen everything. |
| `neighbourhoodTruncated` | boolean | no | Expansion was cut short by the node budget or time limit, not the search itself. Distinct from searchTruncated: the search covered the window, but some matches did not get their full neighbourhood. |
| `revision` | integer | yes |  |
| `searchTruncated` | boolean | yes | The search gave up before covering the window. |

---

### `releaseElement`

**Operation class:** `edit`

Give a claimed element back before its lease runs out. Releasing what you do not hold is not an error: the desired state is that this client owns nothing here, and it is already true. A client that disconnects releases everything it held, because an element owned by a process that no longer exists is owned forever.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |
| `elementId` | string | yes |  |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `heldForMs` | integer | no |  |
| `released` | boolean | yes | True when this call gave up a claim, false when there was nothing of this client's to give up. |
| `revision` | integer | yes |  |

---

### `setAttention`

**Operation class:** `observe`

Declare what this connection is looking at. Attention is not permission: it narrows what this one client is shown and how deep it may look, always inside what the consent ceiling already allows. It is per connection, so two agents on one service can watch different things. The call declares the whole attention — a field left out takes its default, and a call with no fields returns the connection to the whole desktop.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `applications` | string[] | no | Applications this connection cares about, by id or by name. Empty means the whole desktop, which is what an undeclared connection gets. |
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |
| `depth` | `surface` \| `tree` | no | How far in to look. 'tree' lifts the depth ceiling on inspection, and only means anything once applications are named: the budget is affordable because the walk starts inside one application rather than at the desktop. |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `applications` | string[] | yes |  |
| `depth` | `surface` \| `tree` | yes |  |
| `maxDepth` | integer | yes | The depth ceiling now in force for this connection, so a client learns what its declaration bought rather than discovering it by truncation. |
| `revision` | integer | yes |  |

---

### `setElementValue`

**Operation class:** `edit`

Set an element's text through the accessibility editable-text interface, or its numeric value through the value interface. Never by synthesizing keystrokes.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no |  |
| `elementId` | string | yes |  |
| `settleMs` | integer | no |  |
| `value` | string \| number | yes | Text for an editable-text element, a number for a value element. The element decides which applies; a mismatch is an error rather than a coercion. |

**Result:** [`actionResult`](#actionresult)

---

### `setObservationMode`

**Operation class:** `observe`

Tell the service how hard to watch. The runtime owns cadence because the events that justify going fast — filesystem changes, transcripts, timers, agent activity — are invisible from here.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `ceilingMs` | integer | no | Hard upper bound on holding a batch, so a continuously busy desktop still reports in. |
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |
| `debounceMs` | integer | no | Quiet period before a batch of changes is released. |
| `mode` | `active` \| `idle` | yes |  |
| `reconcileIntervalMs` | integer | no | How often the reconciliation sweep runs in this mode. The sweep catches what the event stream dropped; it is not how changes are noticed. Idle backs this off, it does not stop subscribing. |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `ceilingMs` | integer | yes |  |
| `debounceMs` | integer | yes |  |
| `observationMode` | `active` \| `idle` | yes |  |
| `reconcileIntervalMs` | integer | yes |  |
| `revision` | integer | yes |  |

---

### `subscribeElement`

**Operation class:** `observe`

Declare intent to be told about changes to an element without holding a call open. A subscription is an observation claim, not a write claim: it does not prevent anyone else from acting on the element, and no subscription outranks the person at the keyboard. The element is resolved first — subscribing to an id that names nothing is an unkeepable promise. Subscribed elements are sampled on every observation sweep regardless of recency, because a declared intent outranks a heuristic that ranks by how recently something was touched. Over the per-connection ceiling is a refusal that names the ceiling, never a silent truncation: a service that accepts a thousand subscriptions and quietly samples the first sixteen has reinvented the current bug with better manners. A disconnecting client's subscriptions are all released, exactly as a claim is.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no |  |
| `elementId` | string | yes |  |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `revision` | integer | yes |  |
| `subscribed` | boolean | yes |  |

---

### `typeKeystrokes`

**Operation class:** `edit`

Type into an element through synthetic keyboard events when the editable-text interface that typeText and setElementValue use is unavailable. The element is on the accessibility bus and its text can be read back, but it offers no way to write through it — a Discord composer, a browser input that only listens to key events. This is a deliberate escalation, not a fallback: the caller tried the accessible write and it refused, and the cost of typing at a window is that focus must be where the caller believes it is. Requires focus and reports which window it raised. Success is the field reading back what was typed, verified the same way as typeText.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no |  |
| `elementId` | string | yes |  |
| `replace` | boolean | no | Clear the field first by selecting all and deleting, since there is no editable-text interface to empty directly. Defaults to false, which appends. |
| `settleMs` | integer | no |  |
| `text` | string | yes | What to type. Bounded for the same reason as typeText: the call is held open while it types, and a caller cannot wait forever. Characters outside printable Latin-1 are refused rather than typed as the wrong glyph. |
| `wordsPerMinute` | integer | no | Typing speed. Defaults to a competent typist. Unlike typeText this is not only presentation: keys arrive at an application one at a time through the X server, and an application that is busy drops the ones it was not ready for. |

**Result:** [`actionResult`](#actionresult)

---

### `typeText`

**Operation class:** `edit`

Put text into an editable element the way a person would: a word at a time, at a typist's speed, through the same editable-text interface dictation software uses. Prefer setElementValue for a form field nobody is watching; prefer this for anything a human will read as it arrives, and for applications that listen for edits rather than for their field being replaced.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no |  |
| `elementId` | string | yes |  |
| `replace` | boolean | no | Clear the field first. Defaults to false, which appends: extending a field is what typing does, and it leaves anything already there alone. |
| `settleMs` | integer | no |  |
| `text` | string | yes | What to type. Bounded because the call is held open for as long as the typing takes, and a caller cannot wait forever. |
| `wordsPerMinute` | integer | no | Typing speed. Defaults to a competent typist. Faster than a person can type is available and is a choice the caller makes knowingly. |

**Result:** [`actionResult`](#actionresult)

---

### `unsubscribeElement`

**Operation class:** `observe`

Stop asking to be told about an element. Releasing what you do not subscribe to is not an error: the desired state is that this client watches nothing here, and it is already true. A client that disconnects is unsubscribed from everything it held.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |
| `elementId` | string | yes |  |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `released` | boolean | yes | True when this call ended a subscription, false when there was nothing of this client's to give up. |
| `revision` | integer | yes |  |

---

### `waitFor`

**Operation class:** `observe`

Wait for a semantic condition. Replaces sleeping in the model's context: the waiting happens in the service and returns the moment the condition holds.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no |  |
| `condition` | `window-opened` \| `window-closed` \| `element-appeared` \| `element-state-changed` \| `revision-advanced` | yes |  |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |
| `elementId` | string | no |  |
| `name` | string | no | Matched case-insensitively as a substring, the same rule queryElements uses. |
| `revision` | integer | no |  |
| `role` | string | no |  |
| `state` | string | no |  |
| `timeoutMs` | integer | yes |  |
| `windowId` | string | no |  |

**Result**

| Field | Type | Required | Description |
|---|---|---|---|
| `change` | [`change`](#change) | no | The change that satisfied the wait, in the same vocabulary the diff engine and the delta stream use. Absent when the condition was satisfied by the revision alone, and absent on timeout: a wait that timed out has no change to report and must not invent one. |
| `reason` | string | no | Present when the wait was not satisfied: which condition was still false. A timeout is a normal answer, and this is the part of it a caller can act on. |
| `revision` | integer | yes |  |
| `satisfied` | boolean | yes |  |
| `waitedMs` | integer | yes |  |

---

## Shared types

### `actionResult`

The result of one action, including the effects it was seen to have. A caller that reads this does not need to re-inspect.

| Field | Type | Required | Description |
|---|---|---|---|
| `actionId` | string | yes | Identifies this action's revision range, which the delta engine reads to attribute later changes. |
| `backend` | string | yes |  |
| `durationMs` | integer | yes |  |
| `error` | [`errorData`](#errordata) | no |  |
| `fallbacksUsed` | string[] | yes |  |
| `observedEffects` | [`observedEffects`](#observedeffects) | no |  |
| `ok` | boolean | yes |  |
| `progress` | object | no | How far an action that takes real time actually got, present whether or not it succeeded. An action interrupted partway has still changed the desktop, so a deadline or a stalled application is reported here rather than raised: the caller reads how much landed, decides whether waiting is still reasonable, and acts on the state instead of on the absence of an answer. |

---

### `bounds`

Screen rectangle in pixels. Reported for orientation and for the user's benefit; it is not an addressing mechanism and no method in this protocol accepts coordinates.

| Field | Type | Required | Description |
|---|---|---|---|
| `height` | integer | yes |  |
| `width` | integer | yes |  |
| `x` | integer | yes |  |
| `y` | integer | yes |  |

---

### `capabilityTierReport`

One tier's availability. An unavailable tier is always reported with a reason, never omitted.

| Field | Type | Required | Description |
|---|---|---|---|
| `available` | boolean | yes |  |
| `detail` | object | no |  |
| `id` | `app-native` \| `accessibility` \| `compositor` \| `vision` \| `raw-input` | yes |  |
| `name` | string | yes |  |
| `reason` | string \| null | no | Why it is unavailable. Required reading when available is false. |

---

### `change`

One semantic change, produced by the single diff engine. Says what changed and where, never where on screen.

| Field | Type | Required | Description |
|---|---|---|---|
| `applicationId` | string | no |  |
| `applicationName` | string | no | The application this change happened in. Present because the identifier above is opaque, and a reader deciding whether a change concerns them should not have to look one up to find out. |
| `attribution` | `self` \| `external` \| `unattributed` | no |  |
| `detail` | object | no | Kind-specific facts, such as the old and new value of a changed state. |
| `elementId` | string | no |  |
| `kind` | `window-opened` \| `window-closed` \| `focus-changed` \| `element-appeared` \| `element-disappeared` \| `element-state-changed` \| `element-value-changed` \| `element-stale` | yes |  |
| `revision` | integer | yes | The revision at which this change was observed. |
| `summary` | string | yes | One human-readable sentence. Passed through the value-egress point, because it can quote an element's name. |
| `windowId` | string | no |  |

---

### `elementClaim`

One client's exclusive right to write one element, for a bounded time. A claim is not permission — permission is a separate question, already answered by the consent ceiling — and it is not a queue. It answers only 'who is allowed to be mid-sentence in this field right now'.

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | yes | The issued identity holding the claim, never a name a client chose for itself. |
| `clientLabel` | string | no | The holder's readable label, for telling a person who is in their field. |
| `elementId` | string | yes |  |
| `expiresInMs` | integer | yes | Time left on the lease, as of this answer. |
| `heldForMs` | integer | yes |  |
| `leaseMs` | integer | yes | The lease as granted, so a caller can tell a long claim from an old one. |
| `reason` | string | no | What the holder said it was doing. Present when it said. |

---

### `errorData`

The data member of a JSON-RPC error. The domain code lives here; the top-level code stays a reserved JSON-RPC number.

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | `APPLICATION_NOT_FOUND` \| `WINDOW_NOT_FOUND` \| `ELEMENT_NOT_FOUND` \| `ELEMENT_REFERENCE_STALE` \| `BACKEND_UNAVAILABLE` \| `ACTION_NOT_SUPPORTED` \| `PERMISSION_DENIED` \| `SESSION_EXPIRED` \| `ELEMENT_HELD` \| `TIMEOUT` \| `METHOD_NOT_FOUND` \| `INVALID_PARAMS` \| `INTERNAL_ERROR` \| `SUBSCRIPTION_LIMIT_REACHED` \| `ATTESTATION_FAILED` \| `ATTESTATION_STALE` | yes |  |
| `detail` | object | no |  |
| `message` | string | no | Present when this error travels inside a result rather than as a JSON-RPC error. A failed step inside a batch has no top-level error member to carry its explanation, and a report that says a step failed without saying why is not worth returning. |

---

### `observedEffects`

What happened while an action was in flight. Range-only by design: it answers 'what moved while I did that', which is a different question from 'what did I cause'. A change here may still be classed unattributed in a delta. The divergence is intended and documented.

| Field | Type | Required | Description |
|---|---|---|---|
| `changes` | [`change`](#change)[] | yes |  |
| `fromRevision` | integer | yes |  |
| `partial` | boolean | no | True when the settling ceiling fired before the desktop went quiet, so more effects may follow. Never omitted silently when true. |
| `settledMs` | integer | no | How long the service waited for the desktop to go quiet. |
| `toRevision` | integer | yes |  |

---

### `requestCommon`

Fields every request may carry. Declared at freeze time so segment 3 adds enforcement without adding a field.

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | no | Which client is asking. Multiple clients share one service instance and one element namespace; this is for audit and scope, not for addressing. |
| `confirm` | boolean | no | Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required. |

---

### `responseCommon`

Fields every response carries so a caller always knows when it was observed and how.

| Field | Type | Required | Description |
|---|---|---|---|
| `backend` | string | no | Which backend answered. |
| `fallbacksUsed` | string[] | no | Backends tried before the one that answered. Empty when the preferred backend worked. |
| `observationMode` | `active` \| `idle` | no |  |
| `revision` | integer | no | The session revision these results were observed at. |

---

### `scopeAnchor`

A place in the accessibility tree that a permission hangs on, and what may be done there. An application is the outermost place there is, and most tasks mean something far narrower: 'fill in this form' expressed as 'edit anything in the browser' draws the boundary around the wrong thing. Anchors are resolved against the live tree on every call, never remembered as an answer, and the nearest one covering the target decides — so a subtree granted observe with one field inside it granted edit composes without either rule knowing about the other.

| Field | Type | Required | Description |
|---|---|---|---|
| `coversDescendants` | boolean | no | Whether this speaks for everything under it or only for the one node it names. Defaults to false: a grant on a single field that silently reached everything beneath it would be the widening anchors exist to prevent. |
| `operationClasses` | `observe` \| `edit` \| `activate` \| `submit` \| `destructive`[] | yes | What may be done at this place. Faces the ceiling like every other class named in a grant: an anchor is a narrowing device, never a side door. |
| `target` | string | yes | The place this hangs on: an element id, a window id, or an application name. Ids are matched exactly, because an id is minted rather than typed and a substring of one is a coincidence. Application names are matched as substrings, the same way they are everywhere else. |

---

### `semanticElement`

One thing on the desktop, as a caller sees it.

| Field | Type | Required | Description |
|---|---|---|---|
| `actions` | string[] | yes | Action names invokable on this element. For a window this is often the application's whole command set. |
| `ancestry` | [`semanticElement`](#semanticelement)[] | no | Ancestor chain for this element, nearest first, up to the requested depth. Present only when the caller asked for ancestor expansion. Each entry is a full element whose id is valid for getElement. |
| `backend` | `atspi` \| `compositor` | yes |  |
| `bounds` | [`bounds`](#bounds) | no |  |
| `children` | [`semanticElement`](#semanticelement)[] | no |  |
| `extra` | object | no | Backend-specific detail that does not fit the common model, namespaced by backend. Present so richer backends are not flattened to a lowest common denominator. |
| `id` | string | yes | Stable reference. Valid for the service instance's lifetime. Never reused for a different element. |
| `name` | string | yes | Accessible name. Passed through the value-egress point. |
| `role` | string | yes | What kind of thing it is, in the backend's vocabulary. |
| `siblings` | [`semanticElement`](#semanticelement)[] | no | Immediate neighbours of this element under the same parent, up to a per-hit cap. Present only when the caller asked for sibling expansion. |
| `states` | string[] | yes |  |
| `truncated` | boolean | no | Present and true when this element has children the walk did not return, whether because the node budget ran out or because the depth limit was reached. Never silently omitted: a subtree that was cut off must never be indistinguishable from one that ended. Drill from this element with inspectElement to see what is below it. |
| `value` | string | no | Current value, for elements that hold one. Passed through the value-egress point. |

---

## Enum reference

### `attentionDepth`

How far into what it is watching a client wants to see. Attention is not permission: it narrows what one connection is shown, inside whatever the consent ceiling already allows. See A11 in the amendments.

| Value | Meaning |
|---|---|
| `surface` | The top of each window. The shallow default budget, which is all a client watching the whole desktop can afford. |
| `tree` | The whole tree under what the client is attending to. Affordable only once attention names applications, because then the walk starts inside one of them rather than at the desktop. |

### `attribution`

Who caused a change. Three values, not two: the honest third answer exists because a revision range is a time window, and a change landing inside an action's window is not proof that the action caused it.

| Value | Meaning |
|---|---|
| `self` | Inside the action's revision range and inside its causal scope. The agent did this. |
| `external` | Something outside the agent's causal scope did this. This is news. |
| `unattributed` | Inside the range but outside the scope, or otherwise undecidable. Deliberately not guessed. |

### `capabilityTier`

The complete tier vocabulary, including tiers deliberately not implemented. Declared complete at freeze so deferred backends land as additive fills rather than as a widened enum.

| Value | Meaning |
|---|---|
| `app-native` | An application's own automation protocol. Deferred: browser integrations are out of scope for now. |
| `accessibility` | AT-SPI2 via GObject Introspection. The general backend. |
| `compositor` | Window management facts from the display server or compositor. |
| `vision` | Screen capture with OCR or a vision model. Out of scope by design. |
| `raw-input` | Synthetic pointer and keyboard events. Out of scope by design. |

### `changeKind`

The complete vocabulary of semantic changes. One engine produces these for both an action's observedEffects and a pushed delta, so a reader learns one vocabulary rather than two.

| Value | Meaning |
|---|---|
| `window-opened` | A window that did not exist at the earlier revision exists now. |
| `window-closed` | A window that existed at the earlier revision is gone. |
| `focus-changed` | The active window changed. |
| `element-appeared` | A tracked element's subtree gained a child that matters. |
| `element-disappeared` | A tracked element is no longer reachable. |
| `element-state-changed` | A tracked element's states changed, such as becoming checked or insensitive. |
| `element-value-changed` | A tracked element's text or value changed. |
| `element-stale` | A held reference stopped describing the same element. The agent is told without having to discover it by using the reference. |

### `errorCode`

The complete domain error vocabulary. Carried in the JSON-RPC error object under data.code.

| Value | Meaning |
|---|---|
| `APPLICATION_NOT_FOUND` | No application matches the given id. |
| `WINDOW_NOT_FOUND` | No window matches the given id. |
| `ELEMENT_NOT_FOUND` | No element matches the given id in this service instance. |
| `ELEMENT_REFERENCE_STALE` | The element id is known but no longer describes the same element. Carries what changed and, when the element was re-found, its new id. |
| `BACKEND_UNAVAILABLE` | The backend that would answer this call is not available in this session. |
| `ACTION_NOT_SUPPORTED` | The element exists but does not offer the requested action. |
| `PERMISSION_DENIED` | The caller's granted scope does not include this operation class, or the target application is blocked. |
| `SESSION_EXPIRED` | The client session's grant has expired and must be renewed. Distinct from PERMISSION_DENIED so a caller can tell 'never allowed' from 'allowed, ask again'. |
| `ELEMENT_HELD` | Another client is writing this element and owns it until that write finishes. Carries the holder's identity, what it is doing and how long it has been at it. Not a permission answer and not a queue: the request is refused, not deferred. |
| `CLAIM_EXPIRED` | The claim covering this write ran out before the write finished. A lease is sized from the work it was taken for, so this says the work outran its own estimate rather than that time merely passed. The element is free and nothing was rolled back: a half-written field is a real state of the world, and hiding it would be the more expensive lie. |
| `SUBSCRIPTION_LIMIT_REACHED` | This connection already holds the maximum number of element subscriptions. Carries the ceiling, because a refusal that names the bound lets a caller choose what to release rather than guessing. |
| `ATTESTATION_FAILED` | The service could not assemble a proof for a submit-class action, so the action was never dispatched. Not a permission answer: the caller may do this, but the service could not confirm what it would be doing it to, and a commit the service cannot describe is a commit nobody can review. Carries the criterion that could not be satisfied. |
| `ATTESTATION_STALE` | The target moved between the proof and the commit, so the approval was obtained for one state of the desktop and would have been applied to another. Carries the criterion and the revision at which the difference appeared, because a caller told only 'stale' has to guess what to prove again. |
| `TIMEOUT` | The desktop did not answer within the allotted time. |
| `METHOD_NOT_FOUND` | No such method in this protocol version. |
| `INVALID_PARAMS` | The request did not satisfy this schema. |
| `INTERNAL_ERROR` | The service failed in a way that is not the caller's fault. |

### `observationMode`

How hard the service watches the desktop. Set by the client; the service reports which mode it is in. See A2 in the amendments: the runtime owns cadence because most events that justify going fast are invisible to the desktop service.

| Value | Meaning |
|---|---|
| `active` | Fast reconciliation, short debounce, low latency. For when work is happening. |
| `idle` | Backed-off reconciliation. Events are still subscribed to and still delivered; only the reconciliation sweep slows down. |

### `waitCondition`

What a caller can wait for, expressed semantically. This exists so that waiting happens in the service rather than as a sleep in the model's context.

| Value | Meaning |
|---|---|
| `window-opened` | A window whose title matches appears. |
| `window-closed` | A known window disappears. |
| `element-appeared` | An element matching a role and name appears in a window. |
| `element-state-changed` | A held element gains or loses a named state. |
| `revision-advanced` | The session revision passes a given number. |

