"""Which applications this service will not photograph.

Every piece of text that leaves this service goes through one door in `model.py`,
where a redaction policy can rewrite it. Pixels have no such door: an image of a
password manager is an image of the passwords, and no filter that understands
strings can help. So capture is gated on the *application* instead — a blocked
application yields no image at all, rather than a blurred one.

The blocklist is configuration, not a model-facing surface. Nothing a caller sends
can widen it, because a permission an agent can grant itself is not a permission.
Segment 3 replaces the environment variable with the same grant machinery that
gates every other acting method; the refusal, its error code and this module's
place in the call path do not change when it does.
"""

from __future__ import annotations

import os

BLOCKLIST_VARIABLE = "DESKTOP_CAPTURE_BLOCKED_APPLICATIONS"

_override: frozenset[str] | None = None


def _configured() -> frozenset[str]:
    raw = os.environ.get(BLOCKLIST_VARIABLE, "")
    return frozenset(part.strip().casefold() for part in raw.split(",") if part.strip())


def blocked_applications() -> frozenset[str]:
    return _override if _override is not None else _configured()


def set_blocked_applications(names: list[str] | None) -> None:
    """Replace the blocklist for this process. None restores the configured one."""
    global _override
    _override = None if names is None else frozenset(n.strip().casefold() for n in names if n.strip())


def capture_refusal(application_name: str) -> str:
    """Why this application cannot be captured, or an empty string when it can.

    Matched on the application's name rather than its id: ids are per-session
    handles, and a blocklist that has to be rewritten every time the desktop
    restarts is a blocklist nobody keeps accurate.
    """

    if application_name.strip().casefold() in blocked_applications():
        return f"{application_name} is on the capture blocklist for this desktop"
    return ""
