"""Handshake and observation cadence.

Two things the protocol says are the client's business rather than the service's:
which protocol version we agree on, and how hard to watch the desktop. Both live
here because both are per service instance and neither touches a toolkit.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from . import identity
from .errors import DesktopError, ErrorCode
from .protocol_generated import PROTOCOL_VERSION, SCHEMA_DIGEST

#: Active-mode defaults. These are the values segment 2's delta engine starts
#: from; idle backs off from them. Named here rather than inline so the protocol
#: response can report what is actually in force.
ACTIVE_DEFAULTS: dict[str, int] = {
    "reconcileIntervalMs": 2_000,
    "debounceMs": 750,
    "ceilingMs": 10_000,
}

#: Idle-mode defaults. The reconciliation sweep backs off hard; the debounce
#: relaxes so a burst is reported as one thing. Event subscriptions are untouched
#: by mode — see protocol/README.md, this is the point of the whole design.
IDLE_DEFAULTS: dict[str, int] = {
    "reconcileIntervalMs": 120_000,
    "debounceMs": 3_000,
    "ceilingMs": 60_000,
}


def _major(version: str) -> str:
    return version.split(".", 1)[0]


@dataclass
class Session:
    """One service instance's session state, shared by every connected client."""

    token: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    mode: str = "active"
    timings: dict[str, int] = field(default_factory=lambda: dict(ACTIVE_DEFAULTS))

    def hello(self, params: dict[str, Any]) -> dict[str, Any]:
        requested = params["protocolVersion"]
        if _major(requested) != _major(PROTOCOL_VERSION):
            raise DesktopError(
                ErrorCode.INVALID_PARAMS,
                f"Protocol major version mismatch: client speaks {requested}, "
                f"service speaks {PROTOCOL_VERSION}",
                {
                    "clientProtocolVersion": requested,
                    "serviceProtocolVersion": PROTOCOL_VERSION,
                    "compatible": False,
                },
            )
        # What the client calls itself is recorded as a label. It is not an
        # identity: the identity below was issued when the connection was
        # accepted, before anything the client said could influence it.
        identity.set_label(params.get("clientId") or params.get("clientName"))
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "compatible": True,
            "versionDifference": "none" if requested == PROTOCOL_VERSION else "minor",
            "sessionToken": self.token,
            "observationMode": self.mode,
            # The name this connection will be known by for grants, audit and
            # attribution, whatever the client puts in `clientId` afterwards.
            # Returned so a client can recognise its own actions in a delta
            # without having to be trusted about who it is.
            "clientId": identity.current(),
            # The version the running process was built from, not the version on
            # disk. Clients attach to whichever service instance is already
            # listening, so a client generated against a newer schema meets the
            # difference as METHOD_NOT_FOUND on a method its own types promise
            # exists. This turns that into a comparison it can make itself.
            "schemaDigest": SCHEMA_DIGEST,
        }

    def set_observation_mode(self, params: dict[str, Any]) -> dict[str, Any]:
        mode = params["mode"]
        defaults = ACTIVE_DEFAULTS if mode == "active" else IDLE_DEFAULTS
        # An explicit timing overrides the mode's default; the rest follow the
        # mode. A client that only knows it is going idle should not have to
        # restate three intervals to say so.
        self.timings = {key: params.get(key, defaults[key]) for key in defaults}
        self.mode = mode
        return {"observationMode": self.mode, **self.timings}
