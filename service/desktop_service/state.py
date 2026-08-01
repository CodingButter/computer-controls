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


def snapshot_from_windows(
    revision: int,
    windows: list[dict[str, Any]],
    values: dict[str, str] | None = None,
) -> Snapshot:
    """Build a snapshot from the window records the accessibility backend produces.

    `values` covers only the elements the observer chose to watch. An element absent
    from both snapshots is not reported as changed, which is what makes a bounded
    watch set honest rather than a silent lie about the rest of the desktop.
    """
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
    return Snapshot(revision=revision, windows=facts, values=dict(values or {}))


def _edit_shape(before: str, after: str) -> dict[str, Any]:
    """The shape of an edit: where it happened and how much, never what it said.

    "An element's value changed" is the same sentence whether a letter was typed or
    the whole document was deleted, and a reader holding only that cannot tell which
    happened — which is how an agent misses somebody wiping its work and carries on.

    Lengths are safe to report where content is not. These strings have already been
    through the value-egress point on the way out of the toolkit, so a redacted field
    yields the length of its redaction and never of its secret.
    """
    limit = min(len(before), len(after))
    prefix = 0
    while prefix < limit and before[prefix] == after[prefix]:
        prefix += 1
    suffix = 0
    while suffix < limit - prefix and before[-1 - suffix] == after[-1 - suffix]:
        suffix += 1

    removed = len(before) - prefix - suffix
    added = len(after) - prefix - suffix
    if not after:
        shape = "cleared"
    elif removed and added:
        shape = "replaced"
    elif removed:
        shape = "deleted"
    elif prefix == len(before):
        shape = "appended"
    else:
        shape = "inserted"
    return {
        "shape": shape,
        "lengthBefore": len(before),
        "lengthAfter": len(after),
        "charactersAdded": added,
        "charactersRemoved": removed,
        "unchangedPrefix": prefix,
    }


def _describe_edit(before: str, after: str) -> str:
    """The same shape as a sentence, because the model reads summaries first."""
    shape = _edit_shape(before, after)
    added, removed = shape["charactersAdded"], shape["charactersRemoved"]
    if shape["shape"] == "cleared":
        return f"was cleared — {removed} characters removed"
    if shape["shape"] == "appended":
        return f"grew by {added} characters at the end"
    if shape["shape"] == "inserted":
        return f"gained {added} characters"
    if shape["shape"] == "deleted":
        return f"lost {removed} characters"
    return f"was rewritten — {removed} characters removed, {added} added"


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
                # Omitted rather than null when focus came from nowhere: a reader should
                # not have to know that null and absent mean the same thing here.
                "detail": (
                    {"previousWindowId": before.active_window} if before.active_window else {}
                ),
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
                        f"an element's value {_describe_edit(before.values[element_id], value)}",
                        field=model.SUMMARY,
                        element_id=element_id,
                    ),
                    "detail": _edit_shape(before.values[element_id], value),
                }
            )

    return [{k: v for k, v in change.items() if v is not None} for change in changes]
