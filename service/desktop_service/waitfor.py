"""Waiting for a condition to become true, instead of sleeping and hoping.

A model that sleeps two seconds and re-inspects is doing two wrong things at once: it is
guessing at a duration it cannot know, and it is spending a turn of its own context on
the waiting. Both get worse under load — the guess that worked on an idle desktop is too
short when the machine is busy, which is exactly when the model is least able to tell the
difference between "not yet" and "never".

So conditions are named semantically and evaluated here. The call returns the moment the
condition holds, or reports a timeout that says what was still not true. A timeout is a
normal answer, not an exception: "the dialog never appeared" is information the caller
asked for.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable

from . import state

POLL_INTERVAL_MS = 50
DEFAULT_TIMEOUT_MS = 10_000


@dataclass(frozen=True)
class Condition:
    """What is being waited for, in the protocol's own vocabulary."""

    kind: str
    window_id: str = ""
    element_id: str = ""
    role: str = ""
    name: str = ""
    state_name: str = ""
    revision: int = 0

    def describe(self) -> str:
        """Phrased for the timeout message, which is the only place it is read.

        A timeout that says `waitFor timed out` teaches the caller nothing. One that says
        which condition was still false lets it decide whether to wait longer, try
        another route, or report that the application did not do what was asked.
        """
        if self.kind == "window-opened":
            return f"no window matching {self.name or self.role or 'the filter'} opened"
        if self.kind == "window-closed":
            return f"window {self.window_id} was still open"
        if self.kind == "element-appeared":
            return f"no element matching {self.name or self.role or 'the filter'} appeared"
        if self.kind == "element-state-changed":
            return f"element {self.element_id} never reported state {self.state_name!r}"
        if self.kind == "revision-advanced":
            return f"the session revision never passed {self.revision}"
        return f"condition {self.kind!r} was not met"


def _matches(text: str, wanted: str) -> bool:
    """The same case-insensitive substring rule queryElements uses.

    Stated once and shared rather than reimplemented, so a caller cannot find that the
    name which matched its query fails to match its wait.
    """
    return wanted.lower() in text.lower() if wanted else True


def _window_matches(window: state.WindowFacts, condition: Condition) -> bool:
    if condition.window_id and window.window_id != condition.window_id:
        return False
    if condition.role and window.role != condition.role:
        return False
    return _matches(window.title, condition.name) or _matches(
        window.application_name, condition.name
    )


def evaluate(
    condition: Condition,
    baseline: state.Snapshot,
    current: state.Snapshot,
    find_element: Callable[[Condition], dict[str, Any] | None],
) -> dict[str, Any] | None:
    """True-or-not-yet, in one place, for every condition the protocol names.

    Returns the **change** that satisfied the condition — deliberately the same shape the
    diff engine produces, from the same enum, rather than a vocabulary invented for
    waiting. A caller that waits for a window and a caller that is pushed a delta about a
    window are learning the same fact and should not have to parse it two ways.

    Returning the change rather than a bare boolean also means the caller's next call can
    address what it was waiting for, instead of searching for it again.

    Openings are judged against the baseline taken when the wait began. A window that was
    already open when the caller started waiting is not one that opened.
    """
    if condition.kind == "window-opened":
        for window_id, window in current.windows.items():
            if window_id in baseline.windows:
                continue
            if _window_matches(window, condition):
                return next(
                    change
                    for change in state.diff(baseline, current)
                    if change.get("windowId") == window_id
                    and change["kind"] == "window-opened"
                )
        return None

    if condition.kind == "window-closed":
        if condition.window_id and condition.window_id not in current.windows:
            closed = [
                change
                for change in state.diff(baseline, current)
                if change.get("windowId") == condition.window_id
                and change["kind"] == "window-closed"
            ]
            if closed:
                return closed[0]
            # It was already gone when the wait began: true, but there is no diff to
            # quote for it. Say so plainly rather than inventing a change that nobody
            # observed happening.
            return {
                "kind": "window-closed",
                "revision": current.revision,
                "windowId": condition.window_id,
                "summary": "the window was already closed when the wait began",
            }
        return None

    if condition.kind == "revision-advanced":
        # Satisfied by the revision itself; there is no single change to point at,
        # and the result's change field is optional for exactly this case.
        return {} if current.revision > condition.revision else None

    if condition.kind in ("element-appeared", "element-state-changed"):
        # Elements live below the snapshot's granularity, so this one asks the backend
        # directly rather than pretending a window-level snapshot knows about them.
        return find_element(condition)

    return None


def wait(
    condition: Condition,
    take_snapshot: Callable[[], state.Snapshot],
    find_element: Callable[[Condition], dict[str, Any] | None],
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Block until the condition holds or the timeout elapses.

    Checked once before the first sleep. A condition that is already true must not cost
    a poll interval to notice — and for a caller acting then waiting, already-true is the
    common case rather than the exception.
    """
    started = now()
    deadline = started + timeout_ms / 1000
    baseline = take_snapshot()

    while True:
        current = take_snapshot()
        change = evaluate(condition, baseline, current, find_element)
        if change is not None:
            result = {
                "satisfied": True,
                "waitedMs": int((now() - started) * 1000),
                "revision": current.revision,
            }
            if change:
                result["change"] = change
            return result
        if now() >= deadline:
            # No `change`: nothing changed, and a timeout that invented one of the
            # diff engine's kinds to carry its explanation would be putting a false
            # observation into the same vocabulary real observations use.
            return {
                "satisfied": False,
                "waitedMs": int((now() - started) * 1000),
                "revision": current.revision,
                "reason": condition.describe(),
            }
        sleep(POLL_INTERVAL_MS / 1000)
