"""Settling is timing logic, so it is tested with a scripted desktop and a fake clock.

Driving this against a real desktop would test the desktop. The decisions worth checking
are: does it stop when things go quiet, does it stop when they never do, and does it say
which of those happened.
"""

from __future__ import annotations

from desktop_service import settle, state


def window(window_id: str, title: str = "w", active: bool = False) -> state.WindowFacts:
    return state.WindowFacts(
        window_id=window_id,
        application_id="app-1",
        application_name="Test App",
        title=title,
        role="frame",
        active=active,
    )


def snapshot(revision: int, *windows: state.WindowFacts) -> state.Snapshot:
    return state.Snapshot(revision=revision, windows={w.window_id: w for w in windows})


class Clock:
    """A clock that only moves when something sleeps, so tests are instant."""

    def __init__(self) -> None:
        self.time = 0.0

    def sleep(self, seconds: float) -> None:
        self.time += seconds

    def now(self) -> float:
        return self.time


def script(snapshots: list[state.Snapshot]):
    """Return snapshots in order, then repeat the last one forever."""
    remaining = list(snapshots)

    def take() -> state.Snapshot:
        if len(remaining) > 1:
            return remaining.pop(0)
        return remaining[0]

    return take


def test_a_quiet_desktop_settles_and_is_not_partial() -> None:
    before = snapshot(1, window("win-a"))
    clock = Clock()
    result = settle.wait_for_quiet(
        script([before]), before, quiet_ms=250, ceiling_ms=3000, sleep=clock.sleep, now=clock.now
    )
    assert result.partial is False
    assert result.changes == []
    assert result.settled_ms >= 250


def test_a_change_is_reported_once_the_desktop_holds_still() -> None:
    before = snapshot(1, window("win-a"))
    opened = snapshot(2, window("win-a"), window("win-b", title="A Dialog"))
    clock = Clock()
    result = settle.wait_for_quiet(
        script([before, opened]), before, quiet_ms=250, ceiling_ms=3000, sleep=clock.sleep, now=clock.now
    )
    assert result.partial is False
    kinds = [change["kind"] for change in result.changes]
    assert kinds == ["window-opened"]
    assert result.changes[0]["windowId"] == "win-b"
    assert "A Dialog" in result.changes[0]["summary"]


def test_a_desktop_that_never_stops_moving_returns_partial_at_the_ceiling() -> None:
    before = snapshot(1, window("win-a"))
    restless = [snapshot(n, window("win-a"), window(f"win-{n}")) for n in range(2, 200)]
    clock = Clock()
    result = settle.wait_for_quiet(
        script([before, *restless]), before, quiet_ms=250, ceiling_ms=1000, sleep=clock.sleep, now=clock.now
    )
    assert result.partial is True
    assert result.settled_ms <= 1100
    assert result.changes, "a partial settlement still reports what it did see"


def test_quiet_is_measured_from_the_last_change_not_from_the_start() -> None:
    """Effects arriving in bursts are one settling, not several.

    The first version of this test asserted something false: that a window appearing
    long after the desktop went quiet still belongs to the action. It does not. Once the
    desktop has been still for the quiet interval the action is over, and something that
    happens afterwards is news rather than an effect — which is what `waitFor` and the
    delta stream are for. What must hold is the other direction: while changes keep
    arriving, the wait keeps extending.
    """
    before = snapshot(1, window("win-a"))
    # A change on every other sample, none of them far enough apart to count as quiet.
    trickle = [
        before,
        snapshot(2, window("win-a"), window("win-b")),
        snapshot(2, window("win-a"), window("win-b")),
        snapshot(3, window("win-a"), window("win-b"), window("win-c")),
        snapshot(3, window("win-a"), window("win-b"), window("win-c")),
        snapshot(4, window("win-a"), window("win-b"), window("win-c"), window("win-d")),
    ]
    clock = Clock()
    result = settle.wait_for_quiet(
        script(trickle), before, quiet_ms=250, ceiling_ms=5000, sleep=clock.sleep, now=clock.now
    )
    assert result.partial is False
    # All three arrivals belong to this action, because it never went quiet between them.
    assert [change["kind"] for change in result.changes] == ["window-opened"] * 3
    # And it waited past the whole trickle rather than stopping at the first lull.
    assert result.settled_ms >= 500


def test_focus_moving_is_a_change() -> None:
    before = snapshot(1, window("win-a", active=True), window("win-b"))
    after = snapshot(2, window("win-a"), window("win-b", active=True))
    changes = state.diff(before, after)
    assert [change["kind"] for change in changes] == ["focus-changed"]
    assert changes[0]["windowId"] == "win-b"
    assert changes[0]["detail"]["previousWindowId"] == "win-a"


def test_openings_are_reported_before_the_focus_that_lands_on_them() -> None:
    before = snapshot(1, window("win-a", active=True))
    after = snapshot(2, window("win-a"), window("win-b", active=True))
    kinds = [change["kind"] for change in state.diff(before, after)]
    assert kinds == ["window-opened", "focus-changed"]
