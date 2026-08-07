"""The watcher's timings, tested without a clock and without a desktop.

Every dependency the watcher has on time is injected, which is the only reason these
assertions can be exact. A test that slept would be asserting about the machine's load
average as much as about the code.
"""

from __future__ import annotations

from desktop_service import watch


class FakeScheduler:
    """A scheduler that runs nothing until told, and a clock that moves when asked."""

    def __init__(self) -> None:
        self.now = 0
        self._pending: list[tuple[int, object]] = []

    def schedule(self, delay_ms, fn):
        entry = [delay_ms, fn]
        self._pending.append(entry)

        def cancel() -> None:
            if entry in self._pending:
                self._pending.remove(entry)

        return cancel

    @property
    def delays(self) -> list[int]:
        return [delay for delay, _ in self._pending]

    def run_due(self, advance_ms: int = 0) -> None:
        self.now += advance_ms
        due, self._pending = self._pending, []
        for _, fn in due:
            fn()


def build(changes_per_sample=None, busy=lambda: False, cadence=watch.Cadence()):
    clock = FakeScheduler()
    published: list[watch.Delta] = []
    samples = list(changes_per_sample or [[{"kind": "window-opened", "summary": "a"}]])

    def sample():
        batch = samples.pop(0) if samples else []
        return 7, batch

    watcher = watch.Watcher(
        sample=sample,
        publish=published.append,
        schedule=clock.schedule,
        now_ms=lambda: clock.now,
        busy=busy,
        cadence=cadence,
    )
    return watcher, clock, published


def test_a_burst_of_hints_produces_one_delta() -> None:
    """A menu opening fires a dozen events. A reader wants one delta."""
    watcher, clock, published = build()

    for _ in range(12):
        watcher.hint()
        clock.now += 10

    assert published == []
    clock.run_due()
    assert len(published) == 1
    assert published[0].reason == "hint"
    assert published[0].partial is False


def test_hints_that_never_stop_still_release_at_the_ceiling() -> None:
    """A desktop that never goes quiet must not mean a reader who is never told."""
    watcher, clock, published = build(cadence=watch.Cadence(debounce_ms=750, ceiling_ms=2000))

    watcher.hint()
    for _ in range(10):
        clock.now += 400
        watcher.hint()
        # Each rearm is capped by what is left of the ceiling, never by the debounce
        # alone, or this loop would push the release out forever.
        assert clock.delays[0] <= 750
        clock.run_due()
        if published:
            break

    assert published, "the ceiling never fired"


def test_nothing_is_published_when_nothing_actually_changed() -> None:
    """An event is a hint, not a change. The re-read has the final say."""
    watcher, clock, published = build(changes_per_sample=[[]])

    watcher.hint()
    clock.run_due()

    assert published == []


def test_a_delta_is_held_while_an_action_is_still_settling() -> None:
    """Releasing mid-action would show a half-applied desktop to the reader."""
    settling = {"busy": True}
    watcher, clock, published = build(busy=lambda: settling["busy"])

    watcher.hint()
    clock.run_due(advance_ms=100)
    assert published == [], "released while the action was still in flight"

    settling["busy"] = False
    clock.run_due(advance_ms=100)
    assert len(published) == 1


def test_a_release_forced_by_the_ceiling_mid_action_says_it_is_partial() -> None:
    """The reader is told more of the same story is coming, rather than reading the
    quiet that follows as the end of it."""
    watcher, clock, published = build(
        busy=lambda: True, cadence=watch.Cadence(debounce_ms=100, ceiling_ms=200)
    )

    watcher.hint()
    clock.run_due(advance_ms=150)
    clock.run_due(advance_ms=150)

    assert len(published) == 1
    assert published[0].partial is True


def test_the_sweep_reports_what_no_event_announced() -> None:
    """A change nobody broadcast is invisible until something looks anyway."""
    watcher, clock, published = build()

    watcher.start_sweep()
    assert clock.delays == [watch.DEFAULT_SWEEP_MS]
    clock.run_due(advance_ms=watch.DEFAULT_SWEEP_MS)

    assert len(published) == 1
    assert published[0].reason == "sweep"
    assert clock.delays == [watch.DEFAULT_SWEEP_MS], "the sweep did not schedule the next one"


def test_changing_cadence_does_not_lose_a_hint_already_waiting() -> None:
    watcher, clock, published = build()

    watcher.hint()
    watcher.set_cadence(watch.ACTIVE)
    assert clock.delays == [watch.ACTIVE.debounce_ms]

    clock.run_due()
    assert len(published) == 1
