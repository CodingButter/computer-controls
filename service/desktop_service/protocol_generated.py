"""Protocol bindings for the desktop service."""

# Generated from protocol/schema.json — do not edit.
# Run: node scripts/generate-protocol.mjs
# Protocol version: 1.0   schema sha256: e55ff83a4364192f

from __future__ import annotations

from typing import Any, Final

PROTOCOL_VERSION: Final = "1.0"
SCHEMA_DIGEST: Final = "e55ff83a4364192f"

#: What a method does to the world. Declared here at freeze time so enforcement can be added later without changing any request shape.
OPERATION_CLASSES: Final[tuple[str, ...]] = ("observe", "edit", "activate", "submit", "destructive")

#: The complete tier vocabulary, including tiers deliberately not implemented. Declared complete at freeze so deferred backends land as additive fills rather than as a widened enum.
CAPABILITY_TIERS: Final[tuple[str, ...]] = ("app-native", "accessibility", "compositor", "vision", "raw-input")

#: How hard the service watches the desktop. Set by the client; the service reports which mode it is in. See A2 in the amendments: the runtime owns cadence because most events that justify going fast are invisible to the desktop service.
OBSERVATION_MODES: Final[tuple[str, ...]] = ("active", "idle")

#: How far into what it is watching a client wants to see. Attention is not permission: it narrows what one connection is shown, inside whatever the consent ceiling already allows. See A11 in the amendments.
ATTENTION_DEPTHS: Final[tuple[str, ...]] = ("surface", "tree")

#: The complete vocabulary of semantic changes. One engine produces these for both an action's observedEffects and a pushed delta, so a reader learns one vocabulary rather than two.
CHANGE_KINDS: Final[tuple[str, ...]] = ("window-opened", "window-closed", "focus-changed", "element-appeared", "element-disappeared", "element-state-changed", "element-value-changed", "element-stale")

#: Who caused a change. Three values, not two: the honest third answer exists because a revision range is a time window, and a change landing inside an action's window is not proof that the action caused it.
ATTRIBUTIONS: Final[tuple[str, ...]] = ("self", "external", "unattributed")

#: What a caller can wait for, expressed semantically. This exists so that waiting happens in the service rather than as a sleep in the model's context.
WAIT_CONDITIONS: Final[tuple[str, ...]] = ("window-opened", "window-closed", "element-appeared", "element-state-changed", "revision-advanced")

#: The complete domain error vocabulary. Carried in the JSON-RPC error object under data.code.
ERROR_CODES: Final[tuple[str, ...]] = ("APPLICATION_NOT_FOUND", "WINDOW_NOT_FOUND", "ELEMENT_NOT_FOUND", "ELEMENT_REFERENCE_STALE", "BACKEND_UNAVAILABLE", "ACTION_NOT_SUPPORTED", "PERMISSION_DENIED", "SESSION_EXPIRED", "ELEMENT_HELD", "CLAIM_EXPIRED", "SUBSCRIPTION_LIMIT_REACHED", "ATTESTATION_FAILED", "ATTESTATION_STALE", "TIMEOUT", "METHOD_NOT_FOUND", "INVALID_PARAMS", "INTERNAL_ERROR")

#: Every method mapped to the operation class it belongs to.
OPERATION_CLASS: Final[dict[str, str]] = {
    "attestElement": "observe",
    "auditTail": "observe",
    "captureWindow": "observe",
    "claimElement": "edit",
    "commitElement": "destructive",
    "editText": "edit",
    "emergencyStop": "observe",
    "focusWindow": "activate",
    "getDeltaSince": "observe",
    "getDesktopCapabilities": "observe",
    "getDesktopState": "observe",
    "getElement": "observe",
    "getRevision": "observe",
    "grantScope": "observe",
    "hello": "observe",
    "inspectElement": "observe",
    "inspectWindow": "observe",
    "invokeElement": "submit",
    "launchApplication": "activate",
    "listApplications": "observe",
    "listInstallableApplications": "observe",
    "listWindows": "observe",
    "performActions": "submit",
    "queryElements": "observe",
    "releaseElement": "edit",
    "setAttention": "observe",
    "setElementValue": "edit",
    "setObservationMode": "observe",
    "subscribeElement": "observe",
    "typeText": "edit",
    "unsubscribeElement": "observe",
    "waitFor": "observe",
}

#: Request schema per method, used to reject malformed calls at the boundary.
PARAMS_SCHEMA: Final[dict[str, dict[str, Any]]] = {
    "attestElement": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "type": "boolean",
            },
            "elementId": {
                "description": "The field whose contents are being attested for a later commit.",
                "type": "string",
            },
        },
        "required": [
            "elementId",
        ],
        "type": "object",
    },
    "auditTail": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
            "limit": {
                "maximum": 200,
                "minimum": 1,
                "type": "integer",
            },
        },
        "type": "object",
    },
    "captureWindow": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
            "maxWidth": {
                "description": "Scale the image down to at most this width. Only ever downward: enlarging a capture invents detail that was never captured.",
                "maximum": 4096,
                "minimum": 64,
                "type": "integer",
            },
            "windowId": {
                "type": "string",
            },
        },
        "required": [
            "windowId",
        ],
        "type": "object",
    },
    "claimElement": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "type": "boolean",
            },
            "elementId": {
                "type": "string",
            },
            "estimatedWorkMs": {
                "description": "How long the caller believes its work will take. The lease is this plus a settling margin. Bounded, because a lease nobody can outlive is ownership wearing a lease's name.",
                "maximum": 600000,
                "minimum": 1,
                "type": "integer",
            },
            "forText": {
                "description": "Instead of an estimate: the text about to be typed. The service sizes the lease from it at the words-per-minute given, using the arithmetic the typing will use.",
                "maxLength": 4000,
                "type": "string",
            },
            "reason": {
                "description": "What this claim is for, in the caller's words. Shown to whoever is refused, and recorded in the audit log.",
                "maxLength": 200,
                "type": "string",
            },
            "wordsPerMinute": {
                "maximum": 220,
                "minimum": 10,
                "type": "integer",
            },
        },
        "required": [
            "elementId",
        ],
        "type": "object",
    },
    "commitElement": {
        "additionalProperties": False,
        "properties": {
            "action": {
                "description": "The action to trigger, as reported in the element's actions list. Not an index: indices move. When omitted, the element's first action is used.",
                "type": "string",
            },
            "attestationId": {
                "description": "The attestation returned by attestElement for this field. One attestation admits one commit; a second commit with the same id is refused.",
                "type": "string",
            },
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "type": "boolean",
            },
            "elementId": {
                "description": "The field whose attested contents are being sent.",
                "type": "string",
            },
            "settleMs": {
                "maximum": 10000,
                "minimum": 0,
                "type": "integer",
            },
        },
        "required": [
            "elementId",
            "attestationId",
        ],
        "type": "object",
    },
    "editText": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "type": "boolean",
            },
            "elementId": {
                "type": "string",
            },
            "find": {
                "description": "The existing text to replace. Must appear exactly once: two matches mean the caller does not know which one it meant, and the edit is refused rather than guessed.",
                "maxLength": 4000,
                "type": "string",
            },
            "replaceWith": {
                "description": "What to put in its place. Omit to delete the range outright.",
                "maxLength": 4000,
                "type": "string",
            },
            "settleMs": {
                "maximum": 10000,
                "minimum": 0,
                "type": "integer",
            },
            "showSelection": {
                "description": "Highlight the range before removing it, so a watching human sees what changed. Presentation only: the edit does not need it.",
                "type": "boolean",
            },
            "wordsPerMinute": {
                "description": "When present the replacement is typed at this speed rather than inserted at once, for an edit a person is watching.",
                "maximum": 220,
                "minimum": 10,
                "type": "integer",
            },
        },
        "required": [
            "elementId",
            "find",
        ],
        "type": "object",
    },
    "emergencyStop": {
        "additionalProperties": False,
        "properties": {
            "clear": {
                "description": "Lift a stop rather than raise one. Separate and deliberate: a stop that any subsequent call could clear as a side effect would be a suggestion.",
                "type": "boolean",
            },
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "type": "boolean",
            },
            "reason": {
                "maxLength": 400,
                "type": "string",
            },
        },
        "type": "object",
    },
    "focusWindow": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "type": "boolean",
            },
            "settleMs": {
                "description": "Quiet period the service waits for before reporting effects. The ceiling is protocol-visible rather than a magic number in the code.",
                "maximum": 10000,
                "minimum": 0,
                "type": "integer",
            },
            "windowId": {
                "type": "string",
            },
        },
        "required": [
            "windowId",
        ],
        "type": "object",
    },
    "getDeltaSince": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "description": "Who is asking. Attribution is computed for this caller: the same change reads as 'self' to the client that caused it and 'external' to everyone else.",
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
            "sinceRevision": {
                "description": "The last revision this caller has seen. Changes at or below it are not repeated.",
                "minimum": 0,
                "type": "integer",
            },
        },
        "required": [
            "sinceRevision",
        ],
        "type": "object",
    },
    "getDesktopCapabilities": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "description": "Which client is asking. Multiple clients share one service instance and one element namespace; this is for audit and scope, not for addressing.",
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
        },
        "type": "object",
    },
    "getDesktopState": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
        },
        "type": "object",
    },
    "getElement": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
            "elementId": {
                "type": "string",
            },
        },
        "required": [
            "elementId",
        ],
        "type": "object",
    },
    "getRevision": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
        },
        "type": "object",
    },
    "grantScope": {
        "additionalProperties": False,
        "properties": {
            "anchors": {
                "description": "Places in the tree this grant hangs on, instead of hanging on whole applications. A grant that names anchors has said where it applies, so anywhere else is outside it — the same rule naming applications individually has always had. Omit to grant across applications as before.",
                "items": {
                    "$ref": "#/$defs/scopeAnchor",
                },
                "maxItems": 50,
                "type": "array",
            },
            "applications": {
                "description": "Application names this grant covers, matched as substrings of the application's own name. Omit for every application the configuration allows. Never matched against window titles: a title is text the user typed, and a boundary drawn on it can be moved by typing.",
                "items": {
                    "maxLength": 200,
                    "type": "string",
                },
                "maxItems": 50,
                "type": "array",
            },
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "type": "boolean",
            },
            "criteria": {
                "description": "The questions a commit made under this grant must be answered against. Declared here, at the door, because the party being graded does not write the rubric — a worker cannot reach this field, and the service's own mechanical criteria are asked on top of whatever is named here. A name this service cannot decide is still carried and reported as unchecked, so that asking for review is never worse than asking for nothing.",
                "items": {
                    "maxLength": 80,
                    "type": "string",
                },
                "maxItems": 20,
                "type": "array",
            },
            "operationClasses": {
                "description": "What this client intends to do. Ask for what the task needs and no more: a grant is also a description of the blast radius in the audit log.",
                "items": {
                    "enum": [
                        "observe",
                        "edit",
                        "activate",
                        "submit",
                        "destructive",
                    ],
                    "type": "string",
                },
                "maxItems": 5,
                "minItems": 1,
                "type": "array",
            },
            "reason": {
                "description": "What this is for, in the caller's own words. Recorded in the audit log, where the useful question months later is why, not what.",
                "maxLength": 400,
                "type": "string",
            },
            "seconds": {
                "description": "How long the grant survives without use. Idle time, not a lifetime — a grant being used every second does not expire mid-sentence.",
                "maximum": 86400,
                "minimum": 30,
                "type": "integer",
            },
        },
        "required": [
            "operationClasses",
        ],
        "type": "object",
    },
    "hello": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "clientName": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
            "protocolVersion": {
                "pattern": "^[0-9]+\\.[0-9]+$",
                "type": "string",
            },
        },
        "required": [
            "protocolVersion",
        ],
        "type": "object",
    },
    "inspectElement": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
            "depth": {
                "description": "How far below the anchor to walk. The same bound window inspection uses, and the same dependence on attention — drilling changes where a walk starts, never how far it may go.",
                "maximum": 64,
                "minimum": 1,
                "type": "integer",
            },
            "elementId": {
                "description": "Where the walk starts. Must come from an earlier inspection or query: there is no way to drill into something the caller has not already seen and chosen.",
                "type": "string",
            },
            "excludeRoles": {
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "includeRoles": {
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "maxNodes": {
                "maximum": 1000,
                "minimum": 1,
                "type": "integer",
            },
        },
        "required": [
            "elementId",
        ],
        "type": "object",
    },
    "inspectWindow": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
            "depth": {
                "description": "How far below the window's frame to walk. What the service grants depends on the caller's attention: a connection watching the whole desktop is held to the shallow ceiling, one that has named applications may go as deep as it asks. Over-asking is clamped rather than refused, and the truncation marker says so.",
                "maximum": 64,
                "minimum": 1,
                "type": "integer",
            },
            "excludeRoles": {
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "includeRoles": {
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "maxNodes": {
                "maximum": 1000,
                "minimum": 1,
                "type": "integer",
            },
            "windowId": {
                "type": "string",
            },
        },
        "required": [
            "windowId",
        ],
        "type": "object",
    },
    "invokeElement": {
        "additionalProperties": False,
        "properties": {
            "action": {
                "description": "The action's own name, as reported in the element's actions list. Not an index: indices move.",
                "type": "string",
            },
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "type": "boolean",
            },
            "elementId": {
                "type": "string",
            },
            "settleMs": {
                "maximum": 10000,
                "minimum": 0,
                "type": "integer",
            },
        },
        "required": [
            "elementId",
            "action",
        ],
        "type": "object",
    },
    "launchApplication": {
        "additionalProperties": False,
        "properties": {
            "applicationEntryId": {
                "description": "An id from listInstallableApplications. An id absent from that list is refused rather than attempted.",
                "type": "string",
            },
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "type": "boolean",
            },
            "settleMs": {
                "description": "Quiet period the service waits for before reporting effects. A cold-starting application usually outlasts it; wait on window-opened rather than raising this.",
                "maximum": 10000,
                "minimum": 0,
                "type": "integer",
            },
        },
        "required": [
            "applicationEntryId",
        ],
        "type": "object",
    },
    "listApplications": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
        },
        "type": "object",
    },
    "listInstallableApplications": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
        },
        "type": "object",
    },
    "listWindows": {
        "additionalProperties": False,
        "properties": {
            "applicationId": {
                "type": "string",
            },
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
        },
        "type": "object",
    },
    "performActions": {
        "additionalProperties": False,
        "properties": {
            "actions": {
                "items": {
                    "additionalProperties": False,
                    "properties": {
                        "method": {
                            "description": "Which call this step is. Widened when typing arrived: focus a window and then type into it is the sequence somebody writing a message actually wants, and splitting it across two calls leaves a gap in which the desktop can change underneath the second one.",
                            "enum": [
                                "focusWindow",
                                "invokeElement",
                                "setElementValue",
                                "typeText",
                                "editText",
                            ],
                            "type": "string",
                        },
                        "params": {
                            "additionalProperties": True,
                            "type": "object",
                        },
                    },
                    "required": [
                        "method",
                        "params",
                    ],
                    "type": "object",
                },
                "maxItems": 25,
                "minItems": 1,
                "type": "array",
            },
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "type": "boolean",
            },
            "stopOnFailure": {
                "description": "When true the batch halts at the first failure and reports which actions ran. Defaults to true: continuing a sequence past a step that did not happen is rarely what anyone wants.",
                "type": "boolean",
            },
        },
        "required": [
            "actions",
        ],
        "type": "object",
    },
    "queryElements": {
        "additionalProperties": False,
        "anyOf": [
            {
                "required": [
                    "role",
                ],
            },
            {
                "required": [
                    "name",
                ],
            },
            {
                "required": [
                    "states",
                ],
            },
        ],
        "properties": {
            "ancestors": {
                "description": "Expand each match upward toward the window root, returning up to this many ancestors in the element's ancestry field. Zero or absent means no ancestor expansion. Capped at 32 because a broken toolkit can hand back a non-terminating parent chain.",
                "maximum": 32,
                "minimum": 0,
                "type": "integer",
            },
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
            "descendants": {
                "description": "Expand each match downward, populating the element's children field to this many depth levels. Zero or absent means no descendant expansion.",
                "maximum": 10,
                "minimum": 0,
                "type": "integer",
            },
            "limit": {
                "maximum": 200,
                "minimum": 1,
                "type": "integer",
            },
            "name": {
                "type": "string",
            },
            "role": {
                "type": "string",
            },
            "siblings": {
                "description": "When true, return each match's immediate neighbours (up to a per-hit cap) in the element's siblings field.",
                "type": "boolean",
            },
            "states": {
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "windowId": {
                "type": "string",
            },
        },
        "required": [
            "windowId",
        ],
        "type": "object",
    },
    "releaseElement": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
            "elementId": {
                "type": "string",
            },
        },
        "required": [
            "elementId",
        ],
        "type": "object",
    },
    "setAttention": {
        "additionalProperties": False,
        "properties": {
            "applications": {
                "description": "Applications this connection cares about, by id or by name. Empty means the whole desktop, which is what an undeclared connection gets.",
                "items": {
                    "maxLength": 128,
                    "type": "string",
                },
                "maxItems": 32,
                "type": "array",
            },
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
            "depth": {
                "description": "How far in to look. 'tree' lifts the depth ceiling on inspection, and only means anything once applications are named: the budget is affordable because the walk starts inside one application rather than at the desktop.",
                "enum": [
                    "surface",
                    "tree",
                ],
                "type": "string",
            },
        },
        "type": "object",
    },
    "setElementValue": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "type": "boolean",
            },
            "elementId": {
                "type": "string",
            },
            "settleMs": {
                "maximum": 10000,
                "minimum": 0,
                "type": "integer",
            },
            "value": {
                "description": "Text for an editable-text element, a number for a value element. The element decides which applies; a mismatch is an error rather than a coercion.",
                "type": [
                    "string",
                    "number",
                ],
            },
        },
        "required": [
            "elementId",
            "value",
        ],
        "type": "object",
    },
    "setObservationMode": {
        "additionalProperties": False,
        "properties": {
            "ceilingMs": {
                "description": "Hard upper bound on holding a batch, so a continuously busy desktop still reports in.",
                "minimum": 0,
                "type": "integer",
            },
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
            "debounceMs": {
                "description": "Quiet period before a batch of changes is released.",
                "minimum": 0,
                "type": "integer",
            },
            "mode": {
                "enum": [
                    "active",
                    "idle",
                ],
                "type": "string",
            },
            "reconcileIntervalMs": {
                "description": "How often the reconciliation sweep runs in this mode. The sweep catches what the event stream dropped; it is not how changes are noticed. Idle backs this off, it does not stop subscribing.",
                "minimum": 100,
                "type": "integer",
            },
        },
        "required": [
            "mode",
        ],
        "type": "object",
    },
    "subscribeElement": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "type": "boolean",
            },
            "elementId": {
                "type": "string",
            },
        },
        "required": [
            "elementId",
        ],
        "type": "object",
    },
    "typeText": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "type": "boolean",
            },
            "elementId": {
                "type": "string",
            },
            "replace": {
                "description": "Clear the field first. Defaults to false, which appends: extending a field is what typing does, and it leaves anything already there alone.",
                "type": "boolean",
            },
            "settleMs": {
                "maximum": 10000,
                "minimum": 0,
                "type": "integer",
            },
            "text": {
                "description": "What to type. Bounded because the call is held open for as long as the typing takes, and a caller cannot wait forever.",
                "maxLength": 4000,
                "type": "string",
            },
            "wordsPerMinute": {
                "description": "Typing speed. Defaults to a competent typist. Faster than a person can type is available and is a choice the caller makes knowingly.",
                "maximum": 220,
                "minimum": 10,
                "type": "integer",
            },
        },
        "required": [
            "elementId",
            "text",
        ],
        "type": "object",
    },
    "unsubscribeElement": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
            "elementId": {
                "type": "string",
            },
        },
        "required": [
            "elementId",
        ],
        "type": "object",
    },
    "waitFor": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "type": "string",
            },
            "condition": {
                "enum": [
                    "window-opened",
                    "window-closed",
                    "element-appeared",
                    "element-state-changed",
                    "revision-advanced",
                ],
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
            "elementId": {
                "type": "string",
            },
            "name": {
                "description": "Matched case-insensitively as a substring, the same rule queryElements uses.",
                "type": "string",
            },
            "revision": {
                "minimum": 0,
                "type": "integer",
            },
            "role": {
                "type": "string",
            },
            "state": {
                "type": "string",
            },
            "timeoutMs": {
                "maximum": 120000,
                "minimum": 1,
                "type": "integer",
            },
            "windowId": {
                "type": "string",
            },
        },
        "required": [
            "condition",
            "timeoutMs",
        ],
        "type": "object",
    },
}

RESULT_SCHEMA: Final[dict[str, dict[str, Any]]] = {
    "attestElement": {
        "additionalProperties": False,
        "properties": {
            "attestationId": {
                "description": "Identifies this attestation. Present it to commitElement within its TTL; one attestation admits exactly one commit.",
                "type": "string",
            },
            "expiresInMs": {
                "description": "How long before the attestation must be retaken. A stale attestation is not reusable.",
                "minimum": 0,
                "type": "integer",
            },
        },
        "required": [
            "attestationId",
            "expiresInMs",
        ],
        "type": "object",
    },
    "auditTail": {
        "additionalProperties": False,
        "properties": {
            "entries": {
                "items": {
                    "type": "object",
                },
                "type": "array",
            },
            "path": {
                "type": "string",
            },
            "writeFailures": {
                "description": "Records this service could not write. Non-zero means the log is incomplete, which a reader has to be told rather than left to infer from a gap.",
                "type": "integer",
            },
            "written": {
                "type": "integer",
            },
        },
        "required": [
            "entries",
            "path",
        ],
        "type": "object",
    },
    "captureWindow": {
        "additionalProperties": False,
        "properties": {
            "backend": {
                "type": "string",
            },
            "capturedHeight": {
                "type": "integer",
            },
            "capturedWidth": {
                "description": "Width before the invisible client-side-decoration margin was cropped away. Differs from width on GTK windows, which reserve room for their own drop shadow.",
                "type": "integer",
            },
            "format": {
                "enum": [
                    "png",
                ],
                "type": "string",
            },
            "frameCropped": {
                "type": "boolean",
            },
            "height": {
                "type": "integer",
            },
            "image": {
                "description": "The image itself, base64-encoded, so a capture travels over any transport this protocol is carried on rather than only over one with a shared filesystem.",
                "type": "string",
            },
            "revision": {
                "type": "integer",
            },
            "scaled": {
                "type": "boolean",
            },
            "width": {
                "type": "integer",
            },
            "windowId": {
                "type": "string",
            },
        },
        "required": [
            "windowId",
            "format",
            "image",
            "width",
            "height",
            "backend",
            "revision",
        ],
        "type": "object",
    },
    "claimElement": {
        "additionalProperties": False,
        "properties": {
            "claim": {
                "$ref": "#/$defs/elementClaim",
            },
            "revision": {
                "minimum": 0,
                "type": "integer",
            },
        },
        "required": [
            "claim",
            "revision",
        ],
        "type": "object",
    },
    "commitElement": {
        "$ref": "#/$defs/actionResult",
    },
    "editText": {
        "$ref": "#/$defs/actionResult",
    },
    "emergencyStop": {
        "additionalProperties": False,
        "properties": {
            "grantsRevoked": {
                "type": "integer",
            },
            "inFlight": {
                "description": "Actions already dispatched when the stop landed. These are the ones nobody can call back.",
                "type": "integer",
            },
            "stopped": {
                "type": "boolean",
            },
        },
        "required": [
            "stopped",
            "grantsRevoked",
        ],
        "type": "object",
    },
    "focusWindow": {
        "$ref": "#/$defs/actionResult",
    },
    "getDeltaSince": {
        "additionalProperties": False,
        "properties": {
            "changes": {
                "items": {
                    "$ref": "#/$defs/change",
                },
                "type": "array",
            },
            "complete": {
                "description": "False when the caller fell so far behind that the oldest changes it missed are no longer held. An incomplete answer that looked complete would be a lie that reads like calm: a caller told false should re-read rather than assume the quiet was real.",
                "type": "boolean",
            },
            "resumeRevision": {
                "description": "Present when complete is false: the earliest cursor that still yields everything the service holds. Pass it as sinceRevision to resume without a gap. It is a cursor, not the oldest surviving change — sinceRevision is exclusive, so returning the oldest surviving revision would make the caller skip it.",
                "minimum": 0,
                "type": "integer",
            },
            "revision": {
                "minimum": 0,
                "type": "integer",
            },
        },
        "required": [
            "changes",
            "revision",
            "complete",
        ],
        "type": "object",
    },
    "getDesktopCapabilities": {
        "additionalProperties": False,
        "properties": {
            "observationMode": {
                "enum": [
                    "active",
                    "idle",
                ],
                "type": "string",
            },
            "recommendedBackends": {
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "session": {
                "additionalProperties": False,
                "properties": {
                    "compositor": {
                        "type": "string",
                    },
                    "compositorSource": {
                        "type": "string",
                    },
                    "desktopEnvironment": {
                        "type": "string",
                    },
                    "display": {
                        "type": "string",
                    },
                    "displayServer": {
                        "type": "string",
                    },
                    "token": {
                        "type": "string",
                    },
                    "waylandDisplay": {
                        "type": "string",
                    },
                },
                "required": [
                    "token",
                    "displayServer",
                ],
                "type": "object",
            },
            "tiers": {
                "items": {
                    "$ref": "#/$defs/capabilityTierReport",
                },
                "type": "array",
            },
        },
        "required": [
            "session",
            "tiers",
            "recommendedBackends",
        ],
        "type": "object",
    },
    "getDesktopState": {
        "additionalProperties": False,
        "properties": {
            "activeWindowId": {
                "description": "Empty when nothing on this desktop holds focus, which is a real state and not an error.",
                "type": "string",
            },
            "observationMode": {
                "enum": [
                    "active",
                    "idle",
                ],
                "type": "string",
            },
            "revision": {
                "minimum": 0,
                "type": "integer",
            },
            "windows": {
                "items": {
                    "additionalProperties": False,
                    "properties": {
                        "active": {
                            "type": "boolean",
                        },
                        "applicationId": {
                            "type": "string",
                        },
                        "applicationName": {
                            "type": "string",
                        },
                        "role": {
                            "type": "string",
                        },
                        "title": {
                            "type": "string",
                        },
                        "windowId": {
                            "type": "string",
                        },
                    },
                    "required": [
                        "windowId",
                        "applicationId",
                        "title",
                        "role",
                        "active",
                    ],
                    "type": "object",
                },
                "type": "array",
            },
        },
        "required": [
            "windows",
            "activeWindowId",
            "revision",
        ],
        "type": "object",
    },
    "getElement": {
        "additionalProperties": False,
        "properties": {
            "backend": {
                "type": "string",
            },
            "element": {
                "$ref": "#/$defs/semanticElement",
            },
            "revision": {
                "type": "integer",
            },
        },
        "required": [
            "element",
            "revision",
            "backend",
        ],
        "type": "object",
    },
    "getRevision": {
        "additionalProperties": False,
        "properties": {
            "observationMode": {
                "enum": [
                    "active",
                    "idle",
                ],
                "type": "string",
            },
            "revision": {
                "type": "integer",
            },
        },
        "required": [
            "revision",
        ],
        "type": "object",
    },
    "grantScope": {
        "additionalProperties": False,
        "properties": {
            "anchors": {
                "description": "Where this grant now hangs. Returned so a client can tell an anchor that was accepted from one that was quietly dropped.",
                "items": {
                    "$ref": "#/$defs/scopeAnchor",
                },
                "type": "array",
            },
            "applications": {
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "breadth": {
                "additionalProperties": False,
                "description": "How wide a net this scope casts. The competence dimension: breadth, not depth, is what overwhelms a small model.",
                "properties": {
                    "anchors": {
                        "description": "Element-anchored permissions hung on this grant (A15). Each anchor is a separate place to keep track of, so it counts toward the same spread the applications do.",
                        "minimum": 0,
                        "type": "integer",
                    },
                    "applications": {
                        "description": "Distinct applications this grant spans. A weaker model loses track across many.",
                        "minimum": 0,
                        "type": "integer",
                    },
                    "unbounded": {
                        "description": "True when the scope names no applications and neither does the ceiling, so it spans every application there is. The count above is then a floor, not a total.",
                        "type": "boolean",
                    },
                },
                "required": [
                    "applications",
                    "anchors",
                    "unbounded",
                ],
                "type": "object",
            },
            "ceiling": {
                "description": "The most this configuration will ever grant, returned whether or not the request needed all of it, so a client can tell 'not yet' from 'not ever' without asking twice.",
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "criteria": {
                "description": "Every criterion a commit under this grant will be judged against, the mechanical ones included whether or not they were asked for. Returned so a client can tell what review it has actually bought without inferring it from a refusal.",
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "expiresInSeconds": {
                "type": "integer",
            },
            "operationClasses": {
                "description": "What this client now holds. Always includes observe: a client that may edit must be able to check whether its edit worked.",
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "severity": {
                "additionalProperties": False,
                "description": "How much damage a mistake within this scope can cause. A fact about the classes held, not an opinion about which model should hold them.",
                "properties": {
                    "irreversible": {
                        "description": "True when the grant includes a class whose mistakes cannot be taken back (submit, destructive).",
                        "type": "boolean",
                    },
                    "rank": {
                        "description": "Ordinal of the highest operation class held: observe=0, edit=1, activate=2, submit=3, destructive=4.",
                        "minimum": 0,
                        "type": "integer",
                    },
                },
                "required": [
                    "rank",
                    "irreversible",
                ],
                "type": "object",
            },
        },
        "required": [
            "operationClasses",
            "ceiling",
        ],
        "type": "object",
    },
    "hello": {
        "additionalProperties": False,
        "properties": {
            "clientId": {
                "description": "The identity this connection will be known by, issued by the service when the connection was accepted rather than taken from anything the client said. Grants, audit records and change attribution all key off it, so a client that wants to recognise its own actions in a delta should remember this and stop naming itself. A `clientId` sent in any request is kept only as a label. Absent from an older service, which still trusts the caller's own name.",
                "type": "string",
            },
            "compatible": {
                "type": "boolean",
            },
            "observationMode": {
                "enum": [
                    "active",
                    "idle",
                ],
                "type": "string",
            },
            "protocolVersion": {
                "type": "string",
            },
            "schemaDigest": {
                "description": "The schema digest the running service was built from. Clients share one service instance with whoever attached first, so a client whose generated protocol is newer than the running daemon's would otherwise meet the difference as an unexplained METHOD_NOT_FOUND on a method its own types promise exists. Comparing this against its own digest lets a client say the daemon is older than it is, which is the actual problem. Optional so that an older service which never sends it stays compatible.",
                "type": "string",
            },
            "sessionToken": {
                "type": "string",
            },
            "versionDifference": {
                "description": "A minor difference is reported and allowed. A major mismatch fails the call instead of appearing here.",
                "enum": [
                    "none",
                    "minor",
                ],
                "type": "string",
            },
        },
        "required": [
            "protocolVersion",
            "compatible",
            "versionDifference",
            "sessionToken",
        ],
        "type": "object",
    },
    "inspectElement": {
        "additionalProperties": False,
        "properties": {
            "backend": {
                "type": "string",
            },
            "element": {
                "$ref": "#/$defs/semanticElement",
            },
            "nodeCount": {
                "minimum": 0,
                "type": "integer",
            },
            "revision": {
                "minimum": 0,
                "type": "integer",
            },
            "truncated": {
                "description": "True when the walk returned less than the subtree contains, whether it ran out of node budget or reached its depth limit. The elements it stopped at are marked, and are where inspectElement picks up.",
                "type": "boolean",
            },
        },
        "required": [
            "element",
            "nodeCount",
            "truncated",
            "revision",
            "backend",
        ],
        "type": "object",
    },
    "inspectWindow": {
        "additionalProperties": False,
        "properties": {
            "backend": {
                "type": "string",
            },
            "nodeCount": {
                "type": "integer",
            },
            "revision": {
                "type": "integer",
            },
            "truncated": {
                "description": "True when the walk returned less than the subtree contains, whether it ran out of node budget or reached its depth limit. The elements it stopped at are marked, and are where inspectElement picks up.",
                "type": "boolean",
            },
            "window": {
                "$ref": "#/$defs/semanticElement",
            },
        },
        "required": [
            "window",
            "nodeCount",
            "truncated",
            "revision",
            "backend",
        ],
        "type": "object",
    },
    "invokeElement": {
        "$ref": "#/$defs/actionResult",
    },
    "launchApplication": {
        "$ref": "#/$defs/actionResult",
    },
    "listApplications": {
        "additionalProperties": False,
        "properties": {
            "applications": {
                "items": {
                    "additionalProperties": False,
                    "properties": {
                        "backend": {
                            "description": "Which backend observed this application. Present per application for the same reason it is present per element: a mixed-backend result must stay attributable.",
                            "type": "string",
                        },
                        "id": {
                            "type": "string",
                        },
                        "name": {
                            "type": "string",
                        },
                        "pid": {
                            "type": "integer",
                        },
                        "toolkit": {
                            "additionalProperties": False,
                            "properties": {
                                "name": {
                                    "type": "string",
                                },
                                "version": {
                                    "type": "string",
                                },
                            },
                            "required": [
                                "name",
                                "version",
                            ],
                            "type": "object",
                        },
                        "windowCount": {
                            "type": "integer",
                        },
                    },
                    "required": [
                        "id",
                        "name",
                        "pid",
                        "toolkit",
                    ],
                    "type": "object",
                },
                "type": "array",
            },
            "backend": {
                "type": "string",
            },
            "revision": {
                "type": "integer",
            },
        },
        "required": [
            "applications",
            "backend",
        ],
        "type": "object",
    },
    "listInstallableApplications": {
        "additionalProperties": False,
        "properties": {
            "applications": {
                "items": {
                    "additionalProperties": False,
                    "properties": {
                        "description": {
                            "type": "string",
                        },
                        "id": {
                            "description": "The desktop entry id. An opaque handle to the caller: it names an application, it does not describe how to run one.",
                            "type": "string",
                        },
                        "name": {
                            "type": "string",
                        },
                    },
                    "required": [
                        "id",
                        "name",
                    ],
                    "type": "object",
                },
                "type": "array",
            },
            "backend": {
                "type": "string",
            },
            "revision": {
                "minimum": 0,
                "type": "integer",
            },
        },
        "required": [
            "applications",
            "backend",
        ],
        "type": "object",
    },
    "listWindows": {
        "additionalProperties": False,
        "properties": {
            "backend": {
                "type": "string",
            },
            "revision": {
                "type": "integer",
            },
            "windows": {
                "items": {
                    "additionalProperties": False,
                    "properties": {
                        "active": {
                            "type": "boolean",
                        },
                        "applicationId": {
                            "type": "string",
                        },
                        "applicationName": {
                            "type": "string",
                        },
                        "backend": {
                            "type": "string",
                        },
                        "id": {
                            "type": "string",
                        },
                        "role": {
                            "type": "string",
                        },
                        "states": {
                            "items": {
                                "type": "string",
                            },
                            "type": "array",
                        },
                        "title": {
                            "type": "string",
                        },
                    },
                    "required": [
                        "id",
                        "applicationId",
                        "title",
                        "role",
                        "active",
                        "states",
                        "backend",
                    ],
                    "type": "object",
                },
                "type": "array",
            },
        },
        "required": [
            "windows",
            "backend",
        ],
        "type": "object",
    },
    "performActions": {
        "additionalProperties": False,
        "properties": {
            "completed": {
                "description": "How many of the requested actions ran. Less than the number requested means the batch stopped early.",
                "minimum": 0,
                "type": "integer",
            },
            "results": {
                "items": {
                    "$ref": "#/$defs/actionResult",
                },
                "type": "array",
            },
            "revision": {
                "minimum": 0,
                "type": "integer",
            },
        },
        "required": [
            "results",
            "completed",
            "revision",
        ],
        "type": "object",
    },
    "queryElements": {
        "additionalProperties": False,
        "properties": {
            "backend": {
                "type": "string",
            },
            "elements": {
                "items": {
                    "$ref": "#/$defs/semanticElement",
                },
                "type": "array",
            },
            "matchCount": {
                "type": "integer",
            },
            "moreResults": {
                "description": "More matches exist than were returned — either the search was cut short or the answer hit its limit with tree left unwalked. A caller seeing this should narrow its filter rather than assume it has seen everything.",
                "type": "boolean",
            },
            "neighbourhoodTruncated": {
                "description": "Expansion was cut short by the node budget or time limit, not the search itself. Distinct from searchTruncated: the search covered the window, but some matches did not get their full neighbourhood.",
                "type": "boolean",
            },
            "revision": {
                "type": "integer",
            },
            "searchTruncated": {
                "description": "The search gave up before covering the window.",
                "type": "boolean",
            },
        },
        "required": [
            "elements",
            "matchCount",
            "searchTruncated",
            "revision",
            "backend",
        ],
        "type": "object",
    },
    "releaseElement": {
        "additionalProperties": False,
        "properties": {
            "heldForMs": {
                "minimum": 0,
                "type": "integer",
            },
            "released": {
                "description": "True when this call gave up a claim, false when there was nothing of this client's to give up.",
                "type": "boolean",
            },
            "revision": {
                "minimum": 0,
                "type": "integer",
            },
        },
        "required": [
            "released",
            "revision",
        ],
        "type": "object",
    },
    "setAttention": {
        "additionalProperties": False,
        "properties": {
            "applications": {
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "depth": {
                "enum": [
                    "surface",
                    "tree",
                ],
                "type": "string",
            },
            "maxDepth": {
                "description": "The depth ceiling now in force for this connection, so a client learns what its declaration bought rather than discovering it by truncation.",
                "type": "integer",
            },
            "revision": {
                "type": "integer",
            },
        },
        "required": [
            "applications",
            "depth",
            "maxDepth",
            "revision",
        ],
        "type": "object",
    },
    "setElementValue": {
        "$ref": "#/$defs/actionResult",
    },
    "setObservationMode": {
        "additionalProperties": False,
        "properties": {
            "ceilingMs": {
                "type": "integer",
            },
            "debounceMs": {
                "type": "integer",
            },
            "observationMode": {
                "enum": [
                    "active",
                    "idle",
                ],
                "type": "string",
            },
            "reconcileIntervalMs": {
                "type": "integer",
            },
            "revision": {
                "type": "integer",
            },
        },
        "required": [
            "observationMode",
            "reconcileIntervalMs",
            "debounceMs",
            "ceilingMs",
            "revision",
        ],
        "type": "object",
    },
    "subscribeElement": {
        "additionalProperties": False,
        "properties": {
            "revision": {
                "minimum": 0,
                "type": "integer",
            },
            "subscribed": {
                "type": "boolean",
            },
        },
        "required": [
            "subscribed",
            "revision",
        ],
        "type": "object",
    },
    "typeText": {
        "$ref": "#/$defs/actionResult",
    },
    "unsubscribeElement": {
        "additionalProperties": False,
        "properties": {
            "released": {
                "description": "True when this call ended a subscription, false when there was nothing of this client's to give up.",
                "type": "boolean",
            },
            "revision": {
                "minimum": 0,
                "type": "integer",
            },
        },
        "required": [
            "released",
            "revision",
        ],
        "type": "object",
    },
    "waitFor": {
        "additionalProperties": False,
        "properties": {
            "change": {
                "$ref": "#/$defs/change",
                "description": "The change that satisfied the wait, in the same vocabulary the diff engine and the delta stream use. Absent when the condition was satisfied by the revision alone, and absent on timeout: a wait that timed out has no change to report and must not invent one.",
            },
            "reason": {
                "description": "Present when the wait was not satisfied: which condition was still false. A timeout is a normal answer, and this is the part of it a caller can act on.",
                "type": "string",
            },
            "revision": {
                "minimum": 0,
                "type": "integer",
            },
            "satisfied": {
                "type": "boolean",
            },
            "waitedMs": {
                "minimum": 0,
                "type": "integer",
            },
        },
        "required": [
            "satisfied",
            "waitedMs",
            "revision",
        ],
        "type": "object",
    },
}

DEFS: Final[dict[str, dict[str, Any]]] = {
    "actionResult": {
        "additionalProperties": False,
        "description": "The result of one action, including the effects it was seen to have. A caller that reads this does not need to re-inspect.",
        "properties": {
            "actionId": {
                "description": "Identifies this action's revision range, which the delta engine reads to attribute later changes.",
                "type": "string",
            },
            "backend": {
                "type": "string",
            },
            "durationMs": {
                "minimum": 0,
                "type": "integer",
            },
            "error": {
                "$ref": "#/$defs/errorData",
            },
            "fallbacksUsed": {
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "observedEffects": {
                "$ref": "#/$defs/observedEffects",
            },
            "ok": {
                "type": "boolean",
            },
            "progress": {
                "additionalProperties": True,
                "description": "How far an action that takes real time actually got, present whether or not it succeeded. An action interrupted partway has still changed the desktop, so a deadline or a stalled application is reported here rather than raised: the caller reads how much landed, decides whether waiting is still reasonable, and acts on the state instead of on the absence of an answer.",
                "type": "object",
            },
        },
        "required": [
            "actionId",
            "ok",
            "backend",
            "fallbacksUsed",
            "durationMs",
        ],
        "type": "object",
    },
    "bounds": {
        "additionalProperties": False,
        "description": "Screen rectangle in pixels. Reported for orientation and for the user's benefit; it is not an addressing mechanism and no method in this protocol accepts coordinates.",
        "properties": {
            "height": {
                "type": "integer",
            },
            "width": {
                "type": "integer",
            },
            "x": {
                "type": "integer",
            },
            "y": {
                "type": "integer",
            },
        },
        "required": [
            "x",
            "y",
            "width",
            "height",
        ],
        "type": "object",
    },
    "capabilityTierReport": {
        "additionalProperties": False,
        "description": "One tier's availability. An unavailable tier is always reported with a reason, never omitted.",
        "properties": {
            "available": {
                "type": "boolean",
            },
            "detail": {
                "additionalProperties": True,
                "type": "object",
            },
            "id": {
                "enum": [
                    "app-native",
                    "accessibility",
                    "compositor",
                    "vision",
                    "raw-input",
                ],
                "type": "string",
            },
            "name": {
                "type": "string",
            },
            "reason": {
                "description": "Why it is unavailable. Required reading when available is false.",
                "type": [
                    "string",
                    "null",
                ],
            },
        },
        "required": [
            "id",
            "name",
            "available",
        ],
        "type": "object",
    },
    "change": {
        "additionalProperties": False,
        "description": "One semantic change, produced by the single diff engine. Says what changed and where, never where on screen.",
        "properties": {
            "applicationId": {
                "type": "string",
            },
            "applicationName": {
                "description": "The application this change happened in. Present because the identifier above is opaque, and a reader deciding whether a change concerns them should not have to look one up to find out.",
                "type": "string",
            },
            "attribution": {
                "enum": [
                    "self",
                    "external",
                    "unattributed",
                ],
                "type": "string",
            },
            "detail": {
                "additionalProperties": True,
                "description": "Kind-specific facts, such as the old and new value of a changed state.",
                "type": "object",
            },
            "elementId": {
                "type": "string",
            },
            "kind": {
                "enum": [
                    "window-opened",
                    "window-closed",
                    "focus-changed",
                    "element-appeared",
                    "element-disappeared",
                    "element-state-changed",
                    "element-value-changed",
                    "element-stale",
                ],
                "type": "string",
            },
            "revision": {
                "description": "The revision at which this change was observed.",
                "minimum": 0,
                "type": "integer",
            },
            "summary": {
                "description": "One human-readable sentence. Passed through the value-egress point, because it can quote an element's name.",
                "type": "string",
            },
            "windowId": {
                "type": "string",
            },
        },
        "required": [
            "kind",
            "revision",
            "summary",
        ],
        "type": "object",
    },
    "elementClaim": {
        "additionalProperties": False,
        "description": "One client's exclusive right to write one element, for a bounded time. A claim is not permission — permission is a separate question, already answered by the consent ceiling — and it is not a queue. It answers only 'who is allowed to be mid-sentence in this field right now'.",
        "properties": {
            "clientId": {
                "description": "The issued identity holding the claim, never a name a client chose for itself.",
                "type": "string",
            },
            "clientLabel": {
                "description": "The holder's readable label, for telling a person who is in their field.",
                "type": "string",
            },
            "elementId": {
                "type": "string",
            },
            "expiresInMs": {
                "description": "Time left on the lease, as of this answer.",
                "minimum": 0,
                "type": "integer",
            },
            "heldForMs": {
                "minimum": 0,
                "type": "integer",
            },
            "leaseMs": {
                "description": "The lease as granted, so a caller can tell a long claim from an old one.",
                "minimum": 0,
                "type": "integer",
            },
            "reason": {
                "description": "What the holder said it was doing. Present when it said.",
                "type": "string",
            },
        },
        "required": [
            "elementId",
            "clientId",
            "expiresInMs",
            "leaseMs",
            "heldForMs",
        ],
        "type": "object",
    },
    "errorData": {
        "additionalProperties": False,
        "description": "The data member of a JSON-RPC error. The domain code lives here; the top-level code stays a reserved JSON-RPC number.",
        "properties": {
            "code": {
                "enum": [
                    "APPLICATION_NOT_FOUND",
                    "WINDOW_NOT_FOUND",
                    "ELEMENT_NOT_FOUND",
                    "ELEMENT_REFERENCE_STALE",
                    "BACKEND_UNAVAILABLE",
                    "ACTION_NOT_SUPPORTED",
                    "PERMISSION_DENIED",
                    "SESSION_EXPIRED",
                    "ELEMENT_HELD",
                    "TIMEOUT",
                    "METHOD_NOT_FOUND",
                    "INVALID_PARAMS",
                    "INTERNAL_ERROR",
                    "SUBSCRIPTION_LIMIT_REACHED",
                    "ATTESTATION_FAILED",
                    "ATTESTATION_STALE",
                ],
                "type": "string",
            },
            "detail": {
                "additionalProperties": True,
                "type": "object",
            },
            "message": {
                "description": "Present when this error travels inside a result rather than as a JSON-RPC error. A failed step inside a batch has no top-level error member to carry its explanation, and a report that says a step failed without saying why is not worth returning.",
                "type": "string",
            },
        },
        "required": [
            "code",
        ],
        "type": "object",
    },
    "observedEffects": {
        "additionalProperties": False,
        "description": "What happened while an action was in flight. Range-only by design: it answers 'what moved while I did that', which is a different question from 'what did I cause'. A change here may still be classed unattributed in a delta. The divergence is intended and documented.",
        "properties": {
            "changes": {
                "items": {
                    "$ref": "#/$defs/change",
                },
                "type": "array",
            },
            "fromRevision": {
                "minimum": 0,
                "type": "integer",
            },
            "partial": {
                "description": "True when the settling ceiling fired before the desktop went quiet, so more effects may follow. Never omitted silently when true.",
                "type": "boolean",
            },
            "settledMs": {
                "description": "How long the service waited for the desktop to go quiet.",
                "minimum": 0,
                "type": "integer",
            },
            "toRevision": {
                "minimum": 0,
                "type": "integer",
            },
        },
        "required": [
            "fromRevision",
            "toRevision",
            "changes",
        ],
        "type": "object",
    },
    "requestCommon": {
        "description": "Fields every request may carry. Declared at freeze time so segment 3 adds enforcement without adding a field.",
        "properties": {
            "clientId": {
                "description": "Which client is asking. Multiple clients share one service instance and one element namespace; this is for audit and scope, not for addressing.",
                "type": "string",
            },
            "confirm": {
                "description": "Caller's explicit confirmation for an operation whose class requires one. Optional forever: a method that needs it and does not get it fails with PERMISSION_DENIED rather than the field becoming required.",
                "type": "boolean",
            },
        },
        "type": "object",
    },
    "responseCommon": {
        "description": "Fields every response carries so a caller always knows when it was observed and how.",
        "properties": {
            "backend": {
                "description": "Which backend answered.",
                "type": "string",
            },
            "fallbacksUsed": {
                "description": "Backends tried before the one that answered. Empty when the preferred backend worked.",
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "observationMode": {
                "enum": [
                    "active",
                    "idle",
                ],
                "type": "string",
            },
            "revision": {
                "description": "The session revision these results were observed at.",
                "minimum": 0,
                "type": "integer",
            },
        },
        "type": "object",
    },
    "scopeAnchor": {
        "additionalProperties": False,
        "description": "A place in the accessibility tree that a permission hangs on, and what may be done there. An application is the outermost place there is, and most tasks mean something far narrower: 'fill in this form' expressed as 'edit anything in the browser' draws the boundary around the wrong thing. Anchors are resolved against the live tree on every call, never remembered as an answer, and the nearest one covering the target decides — so a subtree granted observe with one field inside it granted edit composes without either rule knowing about the other.",
        "properties": {
            "coversDescendants": {
                "description": "Whether this speaks for everything under it or only for the one node it names. Defaults to false: a grant on a single field that silently reached everything beneath it would be the widening anchors exist to prevent.",
                "type": "boolean",
            },
            "operationClasses": {
                "description": "What may be done at this place. Faces the ceiling like every other class named in a grant: an anchor is a narrowing device, never a side door.",
                "items": {
                    "enum": [
                        "observe",
                        "edit",
                        "activate",
                        "submit",
                        "destructive",
                    ],
                    "type": "string",
                },
                "maxItems": 5,
                "minItems": 1,
                "type": "array",
            },
            "target": {
                "description": "The place this hangs on: an element id, a window id, or an application name. Ids are matched exactly, because an id is minted rather than typed and a substring of one is a coincidence. Application names are matched as substrings, the same way they are everywhere else.",
                "maxLength": 200,
                "type": "string",
            },
        },
        "required": [
            "target",
            "operationClasses",
        ],
        "type": "object",
    },
    "semanticElement": {
        "additionalProperties": False,
        "description": "One thing on the desktop, as a caller sees it.",
        "properties": {
            "actions": {
                "description": "Action names invokable on this element. For a window this is often the application's whole command set.",
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "ancestry": {
                "description": "Ancestor chain for this element, nearest first, up to the requested depth. Present only when the caller asked for ancestor expansion. Each entry is a full element whose id is valid for getElement.",
                "items": {
                    "$ref": "#/$defs/semanticElement",
                },
                "type": "array",
            },
            "backend": {
                "enum": [
                    "atspi",
                    "compositor",
                ],
                "type": "string",
            },
            "bounds": {
                "$ref": "#/$defs/bounds",
            },
            "children": {
                "items": {
                    "$ref": "#/$defs/semanticElement",
                },
                "type": "array",
            },
            "extra": {
                "additionalProperties": True,
                "description": "Backend-specific detail that does not fit the common model, namespaced by backend. Present so richer backends are not flattened to a lowest common denominator.",
                "type": "object",
            },
            "id": {
                "description": "Stable reference. Valid for the service instance's lifetime. Never reused for a different element.",
                "pattern": "^(el|win|app)-[0-9a-f]{12}$",
                "type": "string",
            },
            "name": {
                "description": "Accessible name. Passed through the value-egress point.",
                "type": "string",
            },
            "role": {
                "description": "What kind of thing it is, in the backend's vocabulary.",
                "type": "string",
            },
            "siblings": {
                "description": "Immediate neighbours of this element under the same parent, up to a per-hit cap. Present only when the caller asked for sibling expansion.",
                "items": {
                    "$ref": "#/$defs/semanticElement",
                },
                "type": "array",
            },
            "states": {
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "truncated": {
                "description": "Present and true when this element has children the walk did not return, whether because the node budget ran out or because the depth limit was reached. Never silently omitted: a subtree that was cut off must never be indistinguishable from one that ended. Drill from this element with inspectElement to see what is below it.",
                "type": "boolean",
            },
            "value": {
                "description": "Current value, for elements that hold one. Passed through the value-egress point.",
                "type": "string",
            },
        },
        "required": [
            "id",
            "backend",
            "role",
            "name",
            "states",
            "actions",
        ],
        "type": "object",
    },
}
