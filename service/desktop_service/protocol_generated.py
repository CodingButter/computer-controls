"""Protocol bindings for the desktop service."""

# Generated from protocol/schema.json — do not edit.
# Run: node scripts/generate-protocol.mjs
# Protocol version: 1.0   schema sha256: f649b92ee4ded5d1

from __future__ import annotations

from typing import Any, Final

PROTOCOL_VERSION: Final = "1.0"
SCHEMA_DIGEST: Final = "f649b92ee4ded5d1"

#: What a method does to the world. Declared here at freeze time so enforcement can be added later without changing any request shape.
OPERATION_CLASSES: Final[tuple[str, ...]] = ("observe", "edit", "activate", "submit", "destructive")

#: The complete tier vocabulary, including tiers deliberately not implemented. Declared complete at freeze so deferred backends land as additive fills rather than as a widened enum.
CAPABILITY_TIERS: Final[tuple[str, ...]] = ("app-native", "accessibility", "compositor", "vision", "raw-input")

#: How hard the service watches the desktop. Set by the client; the service reports which mode it is in. See A2 in the amendments: the runtime owns cadence because most events that justify going fast are invisible to the desktop service.
OBSERVATION_MODES: Final[tuple[str, ...]] = ("active", "idle")

#: The complete domain error vocabulary. Carried in the JSON-RPC error object under data.code.
ERROR_CODES: Final[tuple[str, ...]] = ("APPLICATION_NOT_FOUND", "WINDOW_NOT_FOUND", "ELEMENT_NOT_FOUND", "ELEMENT_REFERENCE_STALE", "BACKEND_UNAVAILABLE", "ACTION_NOT_SUPPORTED", "PERMISSION_DENIED", "SESSION_EXPIRED", "TIMEOUT", "METHOD_NOT_FOUND", "INVALID_PARAMS", "INTERNAL_ERROR")

#: Every method mapped to the operation class it belongs to.
OPERATION_CLASS: Final[dict[str, str]] = {
    "getDesktopCapabilities": "observe",
    "getElement": "observe",
    "getRevision": "observe",
    "hello": "observe",
    "inspectWindow": "observe",
    "listApplications": "observe",
    "listWindows": "observe",
    "queryElements": "observe",
    "setObservationMode": "observe",
}

#: Request schema per method, used to reject malformed calls at the boundary.
PARAMS_SCHEMA: Final[dict[str, dict[str, Any]]] = {
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
                "maximum": 12,
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
            "name": {
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
            "windowId": {
                "type": "string",
            },
        },
        "required": [
            "windowId",
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
}

RESULT_SCHEMA: Final[dict[str, dict[str, Any]]] = {
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
    "hello": {
        "additionalProperties": False,
        "properties": {
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
}

DEFS: Final[dict[str, dict[str, Any]]] = {
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
                    "TIMEOUT",
                    "METHOD_NOT_FOUND",
                    "INVALID_PARAMS",
                    "INTERNAL_ERROR",
                ],
                "type": "string",
            },
            "detail": {
                "additionalProperties": True,
                "type": "object",
            },
        },
        "required": [
            "code",
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
            "states": {
                "items": {
                    "type": "string",
                },
                "type": "array",
            },
            "truncated": {
                "description": "Present and true when children were withheld by a node budget. Never silently omitted.",
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
