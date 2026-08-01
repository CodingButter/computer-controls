"""The authoritative state model of the desktop, and the one engine that diffs it.

There is deliberately **one** diff implementation. It serves the effects reported on an
action's own result, the answer to "what changed since revision N", and — in the next
phase — the delta that gets pushed at the agent without being asked for. Three consumers
of one engine, because three engines would drift and the drift would be invisible: each
would be self-consistent and they would quietly disagree with each other.

A snapshot is a plain description of what exists. It holds no toolkit objects, so it can
be compared with an older one long after the windows it describes have closed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import model


@dataclass(frozen=True)
class WindowFacts:
    """What is worth noticing about a window. Not its contents — its existence."""

    window_id: str
    application_id: str
    application_name: str
    title: str
    role: str
    active: bool


@dataclass(frozen=True)
class Snapshot:
    """The desktop at one revision."""

    revision: int
    windows: dict[str, WindowFacts] = field(default_factory=dict)
    values: dict[str, str] = field(default_factory=dict)

    @property
    def active_window(self) -> str:
        for window in self.windows.values():
            if window.active:
                return window.window_id
        return ""


def snapshot_from_windows(revision: int, windows: list[dict[str, Any]]) -> Snapshot:
    """Build a snapshot from the window records the accessibility backend produces."""
    facts = {}
    for window in windows:
        facts[window["id"]] = WindowFacts(
            window_id=window["id"],
            application_id=window.get("applicationId", ""),
            application_name=window.get("applicationName", ""),
            title=window.get("title", ""),
            role=window.get("role", ""),
            active=bool(window.get("active")),
        )
    return Snapshot(revision=revision, windows=facts)


def _describe_window(window: WindowFacts) -> str:
    title = window.title or "(untitled)"
    if window.application_name:
        return f"{window.application_name}: {title}"
    return title


def diff(before: Snapshot, after: Snapshot) -> list[dict[str, Any]]:
    """Every semantic change between two snapshots, in a stable order.

    Ordered openings, then closings, then focus, then values — so that a reader sees a
    window exist before being told the focus moved to it. An unordered set of changes is
    technically the same information and much harder to read.

    Summaries are built through the value-egress point because they quote titles, and a
    title is exactly the kind of text a redaction policy exists to hold back. A delta
    that leaked what a method call would have withheld would make the choke point
    decorative.
    """
    changes: list[dict[str, Any]] = []

    for window_id, window in after.windows.items():
        if window_id not in before.windows:
            changes.append(
                {
                    "kind": "window-opened",
                    "revision": after.revision,
                    "applicationId": window.application_id,
                    "windowId": window_id,
                    "summary": model.egress_value(
                        f"a window appeared — {_describe_window(window)}",
                        field=model.SUMMARY,
                        role=window.role,
                        element_id=window_id,
                        application=window.application_name,
                    ),
                }
            )

    for window_id, window in before.windows.items():
        if window_id not in after.windows:
            changes.append(
                {
                    "kind": "window-closed",
                    "revision": after.revision,
                    "applicationId": window.application_id,
                    "windowId": window_id,
                    "summary": model.egress_value(
                        f"a window closed — {_describe_window(window)}",
                        field=model.SUMMARY,
                        role=window.role,
                        element_id=window_id,
                        application=window.application_name,
                    ),
                }
            )

    if before.active_window != after.active_window:
        now = after.windows.get(after.active_window)
        changes.append(
            {
                "kind": "focus-changed",
                "revision": after.revision,
                "windowId": after.active_window or None,
                "applicationId": now.application_id if now else None,
                "summary": model.egress_value(
                    f"focus moved to {_describe_window(now)}" if now else "focus left every known window",
                    field=model.SUMMARY,
                    role=now.role if now else "",
                    element_id=after.active_window,
                    application=now.application_name if now else "",
                ),
                "detail": {"previousWindowId": before.active_window or None},
            }
        )

    for element_id, value in after.values.items():
        if element_id in before.values and before.values[element_id] != value:
            changes.append(
                {
                    "kind": "element-value-changed",
                    "revision": after.revision,
                    "elementId": element_id,
                    "summary": model.egress_value(
                        "an element's value changed",
                        field=model.SUMMARY,
                        element_id=element_id,
                    ),
                }
            )

    return [{k: v for k, v in change.items() if v is not None} for change in changes]
