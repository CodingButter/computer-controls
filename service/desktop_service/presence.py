"""Who has the keyboard, and what that costs an agent that was using it.

The rule this module exists to enforce was stated plainly: a person reaching for
their own computer outranks an agent working in it, and the agent's cooperation
is not required. Everything below is that sentence made mechanical.

Two facts are combined and neither is sufficient alone:

*When* input last happened comes from the display server's idle timer, which
reports a duration and nothing else — no key, no button, no destination. A clock,
not a keylogger. Because it counts every kind of input, it can only ever say that
somebody is at the machine.

*Where* it went is the window the display server currently calls active. This is
what turns presence into a decision. A human typing in their chat window while an
agent writes into a background editor is not a collision — it is the entire point
of acting through the accessibility layer instead of the keyboard, and stopping
there would make the product useless. A human typing into the window the agent is
writing in is the collision, and it is the only one.

Destination carries the test; time only bounds it.

Nothing here imports a toolkit or a display server. The probes are handed in, so
the rule can be tested on a machine with no desktop at all — which is also how it
survives the port to a platform where both probes are answered by something else
entirely.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

#: How recently input must have happened for a human to count as present. Long
#: enough to cover the gap between two keystrokes of ordinary typing, short
#: enough that somebody who walked away an hour ago is not still holding a field.
HUMAN_RECENT_MS = 1500

#: How long an element stays withheld after a person took it. Not a lock timing
#: out — a courtesy interval. The agent that lost the field does not get it back
#: the instant the typing pauses, because a pause in typing is what reading looks
#: like.
HANDBACK_MS = 5000


@dataclass(frozen=True)
class Reading:
    """One look at the desktop: how long since input, and where focus is."""

    idle_ms: int | None
    active_window: str

    @property
    def human_is_here(self) -> bool:
        """Whether somebody touched this machine recently enough to count.

        An unreadable idle timer answers False. Guessing presence from silence
        would stop agents on every desktop that cannot report it, and a guard
        that fires when it has no evidence is a guard nobody keeps switched on.
        The honest consequence — that takeover cannot be enforced there — belongs
        in the capability report, not in a default that pretends otherwise.
        """
        return self.idle_ms is not None and self.idle_ms <= HUMAN_RECENT_MS


@dataclass(frozen=True)
class Taken:
    """An element a person took, and the client it was taken from."""

    element_id: str
    window_id: str
    taken_from: str
    at: float


class Watch:
    """The presence rule, with its two probes injected.

    One instance lives in the service and is consulted from two places: the paced
    write, between words, and the guard every method passes through. Those are the
    same rule seen twice — one stops what is in flight, the other refuses what
    comes next — and they read the same latch so they cannot disagree.
    """

    def __init__(
        self,
        idle_ms: Callable[[], int | None],
        active_window: Callable[[], str],
        *,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._idle_ms = idle_ms
        self._active_window = active_window
        self._now = now
        self._taken: dict[str, Taken] = {}

    def reading(self) -> Reading:
        """A look at the desktop. Probe failure reads as 'cannot say', never as absence."""
        try:
            idle = self._idle_ms()
        except Exception:
            idle = None
        try:
            active = self._active_window() or ""
        except Exception:
            active = ""
        return Reading(idle_ms=idle, active_window=active)

    def took(self, window_id: str) -> bool:
        """Whether a person is, right now, working in this particular window.

        A window this cannot identify answers False: an action whose target could
        not be located is not evidence that somebody took it, and refusing on a
        missing id would make every unresolvable window permanently untouchable.
        """
        if not window_id:
            return False
        look = self.reading()
        return look.human_is_here and look.active_window == window_id

    def withhold(self, element_id: str, window_id: str, taken_from: str) -> Taken:
        """Record that a person took an element out from under a client."""
        held = Taken(
            element_id=element_id,
            window_id=window_id,
            taken_from=taken_from,
            at=self._now(),
        )
        self._taken[element_id] = held
        return held

    def holder_of(self, element_id: str) -> Taken | None:
        """The person's claim on this element, or None once it has lapsed.

        The claim lapses on two conditions together: the courtesy interval has
        passed *and* the person is no longer in that window. Either one alone
        would hand the field back while they are still using it.
        """
        held = self._taken.get(element_id)
        if held is None:
            return None
        if (self._now() - held.at) * 1000 < HANDBACK_MS:
            return held
        if self.took(held.window_id):
            return held
        del self._taken[element_id]
        return None

    def release(self, element_id: str) -> None:
        """Drop a claim. For the person's own use, never the agent's."""
        self._taken.pop(element_id, None)
