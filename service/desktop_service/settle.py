"""Waiting for the desktop to stop reacting, and recording what it did while it did.

An action does not finish when the accessibility call returns. It finishes when the
application has stopped responding to it — a menu has opened, a dialog has appeared, a
window has taken focus. Returning at the moment the call returns would mean reporting
that nothing happened, every time, and forcing the caller to re-inspect to find out
otherwise.

So every action is followed by a wait for quiet: sample the desktop until two consecutive
samples agree for a quiet interval, or until a ceiling elapses. Both numbers are
protocol-visible parameters rather than constants buried here, because they are the
difference between a reliable result and a fast one, and that trade-off belongs to the
caller.

The ceiling matters as much as the quiet period. A desktop that never goes quiet — an
animation, a spinner, a clock — must not hold an action open forever. When the ceiling
fires first the result says so, and says it in the payload rather than in a log nobody
reads: `partial` means the effects listed are real but incomplete.

**One quiescence detector, not two.** The delta engine in the next phase watches for the
same quiet period this module does. Two independent timers watching the same desktop
would each be right and would still disagree, so the debounce there is built on this,
not beside it.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable

from . import state

#: Starting points, tuned from what the live desktop actually does rather than guessed.
DEFAULT_QUIET_MS = 250
DEFAULT_CEILING_MS = 3000
#: How often the desktop is sampled while waiting. Fast enough that a 250ms quiet period
#: is measured rather than approximated; slow enough that waiting is not a busy loop.
SAMPLE_INTERVAL_MS = 50


@dataclass
class Settlement:
    """What the desktop did while an action was in flight."""

    before: state.Snapshot
    after: state.Snapshot
    changes: list[dict[str, Any]]
    partial: bool
    settled_ms: int


def wait_for_quiet(
    take_snapshot: Callable[[], state.Snapshot],
    before: state.Snapshot,
    quiet_ms: int = DEFAULT_QUIET_MS,
    ceiling_ms: int = DEFAULT_CEILING_MS,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
) -> Settlement:
    """Sample until the desktop holds still, then report what changed.

    `take_snapshot` is injected rather than imported so that this logic can be tested
    without a desktop at all: the tests drive it with a scripted sequence of snapshots
    and assert on the timing decisions, which is the part that can be wrong in a way
    nobody notices.

    Quiet is measured from the last change, not from the start. An action whose effects
    arrive in three bursts is one action that took a while, not three settled desktops.
    """
    started = now()
    deadline = started + ceiling_ms / 1000
    quiet_seconds = quiet_ms / 1000

    latest = before
    last_change_at = started
    partial = True

    while True:
        sleep(SAMPLE_INTERVAL_MS / 1000)
        current = take_snapshot()
        moment = now()

        if state.diff(latest, current):
            last_change_at = moment
        latest = current

        if moment - last_change_at >= quiet_seconds:
            partial = False
            break
        if moment >= deadline:
            # The ceiling fired while the desktop was still moving. Everything reported
            # is true; it is just not all of it, and the caller is told which.
            partial = True
            break

    return Settlement(
        before=before,
        after=latest,
        changes=state.diff(before, latest),
        partial=partial,
        settled_ms=int((now() - started) * 1000),
    )
