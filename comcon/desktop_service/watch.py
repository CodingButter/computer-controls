"""Noticing that the desktop moved, without asking it over and over.

A service that re-enumerated the desktop on a timer would spend nearly all of its budget
proving that nothing had changed. The accessibility bridge already broadcasts the moments
that matter — a window created, focus moved, a value edited — so this module listens for
those and treats them as a *hint that something happened*, never as the change itself.

The distinction is deliberate. An event says "look again"; the diff engine says what is
different. Trusting event payloads directly would mean two sources of truth about the same
desktop, and the one that is easier to trust is the one that re-reads.

Three timings, and they are not the same timing:

* **debounce** — how long after the last hint to look. A menu opening fires a dozen events;
  a reader wants one delta.
* **ceiling** — the longest a change may sit unreported while hints keep arriving. A
  desktop that never goes quiet must not mean a reader who is never told anything.
* **sweep** — a slow re-read that runs whether or not anything was heard. It exists because
  an event that never arrived is invisible by definition, and a sweep that finds a
  discrepancy has not corrected an error: it has found a change, which is news.

Nothing here decides who caused what. Attribution is per-asker and belongs to whoever
asks.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable

log = logging.getLogger(__name__)

#: Starting values, tuned live and recorded in the docs. Deliberately slower than the
#: settling window an action waits out: that one measures a single act, this one batches
#: for a reader who is thinking between messages.
DEFAULT_DEBOUNCE_MS = 750
DEFAULT_CEILING_MS = 10_000
DEFAULT_SWEEP_MS = 60_000


@dataclass(frozen=True)
class Cadence:
    """How eagerly the watcher looks. Set by observation mode, not by guesswork."""

    debounce_ms: int = DEFAULT_DEBOUNCE_MS
    ceiling_ms: int = DEFAULT_CEILING_MS
    sweep_ms: int = DEFAULT_SWEEP_MS


ACTIVE = Cadence(debounce_ms=250, ceiling_ms=2_000, sweep_ms=30_000)
IDLE = Cadence(debounce_ms=3_000, ceiling_ms=120_000, sweep_ms=300_000)


@dataclass(frozen=True)
class Delta:
    """A batch of changes, released to whoever is listening.

    `partial` is not a warning about quality. It says the batch was released while the
    desktop was still moving — the ceiling fired during an action whose effects had not
    finished arriving — so the reader knows more of the same story is coming, rather than
    reading the quiet that follows as the end of it.
    """

    changes: list[dict[str, Any]]
    revision: int
    partial: bool
    reason: str


class Watcher:
    """Turns hints that the desktop moved into batched, re-read deltas.

    Every timing dependency is injected. The scheduler is the GLib loop in the service and
    a list of pending callbacks in the tests, which is what makes the debounce and ceiling
    behaviour testable at all — the alternative is a test suite that sleeps, and a test
    that sleeps is a test that is flaky on a loaded machine.
    """

    def __init__(
        self,
        sample: Callable[[], tuple[int, list[dict[str, Any]]]],
        publish: Callable[[Delta], None],
        schedule: Callable[[int, Callable[[], None]], Callable[[], None]],
        now_ms: Callable[[], int],
        busy: Callable[[], bool] = lambda: False,
        cadence: Cadence = Cadence(),
    ) -> None:
        self._sample = sample
        self._publish = publish
        self._schedule = schedule
        self._now = now_ms
        self._busy = busy
        self._cadence = cadence
        self._cancel: Callable[[], None] | None = None
        self._sweep_cancel: Callable[[], None] | None = None
        self._first_hint_ms: int | None = None

    @property
    def cadence(self) -> Cadence:
        return self._cadence

    def set_cadence(self, cadence: Cadence) -> None:
        """Change how eagerly the watcher looks, without losing a hint already waiting."""
        self._cadence = cadence
        if self._first_hint_ms is not None:
            self._rearm()

    def hint(self, *_: Any) -> None:
        """Something happened. Look soon, but not immediately, and not repeatedly.

        Accepts and discards arguments so it can be handed straight to an event listener
        whose payload this deliberately does not read.
        """
        if self._first_hint_ms is None:
            self._first_hint_ms = self._now()
        self._rearm()

    def _rearm(self) -> None:
        assert self._first_hint_ms is not None
        if self._cancel is not None:
            self._cancel()
            self._cancel = None

        elapsed = self._now() - self._first_hint_ms
        remaining = self._cadence.ceiling_ms - elapsed
        # Never schedule past the ceiling: a desktop that keeps producing hints would
        # otherwise push the debounce out forever and the reader would hear nothing at
        # all, which is the one outcome worse than hearing it late.
        delay = max(0, min(self._cadence.debounce_ms, remaining))
        self._cancel = self._schedule(delay, self._release)

    def _release(self) -> None:
        self._cancel = None
        started = self._first_hint_ms
        elapsed = self._now() - started if started is not None else 0
        at_ceiling = started is not None and elapsed >= self._cadence.ceiling_ms

        # A delta released while an action is still settling would show a half-applied
        # desktop and, worse, would be diffed against by the action's own effects report.
        # It waits for the action's revision range to close — unless the ceiling has run
        # out, in which case the reader is told plainly that this is not the whole story.
        if self._busy() and not at_ceiling:
            self._rearm()
            return

        self._first_hint_ms = None
        self._emit("hint", partial=at_ceiling and self._busy())

    def start_sweep(self) -> None:
        """Begin the slow re-read that runs whether or not anything was heard.

        The sweep is not a safety net for a buggy event stream — it is the only way to
        learn about a change nobody announced. A toolkit that never fires an event for
        something is not reporting an error; it is simply silent, and silence is
        indistinguishable from an unchanged desktop right up until you look.
        """
        self._sweep_cancel = self._schedule(self._cadence.sweep_ms, self._sweep)

    def stop(self) -> None:
        for cancel in (self._cancel, getattr(self, "_sweep_cancel", None)):
            if cancel is not None:
                cancel()
        self._cancel = None
        self._sweep_cancel = None

    def _sweep(self) -> None:
        self._sweep_cancel = None
        try:
            # A sweep that finds something the event stream never mentioned has not
            # corrected a mistake. It has found a change, and it travels as one.
            self._emit("sweep")
        finally:
            self.start_sweep()

    def _emit(self, reason: str, partial: bool = False) -> None:
        revision, changes = self._sample()
        if not changes:
            return
        self._publish(Delta(changes=changes, revision=revision, partial=partial, reason=reason))
