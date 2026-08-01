"""Waiting for conditions, on a fake clock so the tests are instant and deterministic.

The interesting cases are the boundaries: already-true, never-true, and the difference
between "this opened" and "this was already open".
"""

from __future__ import annotations

from desktop_service import waitfor
from tests.test_settle import Clock, snapshot, window


def never_found(_condition):
    return None


def test_a_condition_that_is_already_true_returns_without_waiting() -> None:
    current = snapshot(3, window("win-a"))
    clock = Clock()
    result = waitfor.wait(
        waitfor.Condition(kind="revision-advanced", revision=2),
        lambda: current, never_found, timeout_ms=5000, sleep=clock.sleep, now=clock.now,
    )
    assert result["satisfied"] is True
    assert result["waitedMs"] == 0, "already true must not cost a poll interval"


def test_a_window_that_was_already_open_does_not_count_as_opening() -> None:
    """Otherwise every wait for a dialog succeeds instantly against the wrong window."""
    current = snapshot(1, window("win-a", title="Preferences"))
    clock = Clock()
    result = waitfor.wait(
        waitfor.Condition(kind="window-opened", name="Preferences"),
        lambda: current, never_found, timeout_ms=500, sleep=clock.sleep, now=clock.now,
    )
    assert result["satisfied"] is False
    assert "opened" in result["reason"]


def test_a_window_opening_is_detected_and_its_id_is_returned() -> None:
    frames = [
        snapshot(1, window("win-a")),
        snapshot(1, window("win-a")),
        snapshot(2, window("win-a"), window("win-b", title="Preferences")),
    ]
    calls = {"n": 0}

    def take():
        index = min(calls["n"], len(frames) - 1)
        calls["n"] += 1
        return frames[index]

    clock = Clock()
    result = waitfor.wait(
        waitfor.Condition(kind="window-opened", name="Preferences"),
        take, never_found, timeout_ms=5000, sleep=clock.sleep, now=clock.now,
    )
    assert result["satisfied"] is True
    # The evidence is addressable: the caller can act on it without searching again.
    assert result["change"]["windowId"] == "win-b"


def test_a_window_closing_is_detected() -> None:
    frames = [snapshot(1, window("win-a"), window("win-b")), snapshot(2, window("win-a"))]
    calls = {"n": 0}

    def take():
        index = min(calls["n"], len(frames) - 1)
        calls["n"] += 1
        return frames[index]

    clock = Clock()
    result = waitfor.wait(
        waitfor.Condition(kind="window-closed", window_id="win-b"),
        take, never_found, timeout_ms=5000, sleep=clock.sleep, now=clock.now,
    )
    assert result["satisfied"] is True
    assert result["change"]["windowId"] == "win-b"


def test_a_timeout_says_what_was_still_not_true() -> None:
    current = snapshot(1, window("win-a"))
    clock = Clock()
    result = waitfor.wait(
        waitfor.Condition(kind="element-state-changed", element_id="el-x", state_name="checked"),
        lambda: current, never_found, timeout_ms=300, sleep=clock.sleep, now=clock.now,
    )
    assert result["satisfied"] is False
    assert "el-x" in result["reason"] and "checked" in result["reason"]
    assert 300 <= result["waitedMs"] <= 400


def test_element_conditions_are_answered_by_the_backend_not_the_snapshot() -> None:
    """Elements live below a window snapshot's granularity; pretending otherwise lies."""
    current = snapshot(1, window("win-a"))
    seen = []

    def find(condition):
        seen.append(condition.kind)
        return {"elementId": "el-found"} if len(seen) > 2 else None

    clock = Clock()
    result = waitfor.wait(
        waitfor.Condition(kind="element-appeared", role="push button", name="Save"),
        lambda: current, find, timeout_ms=5000, sleep=clock.sleep, now=clock.now,
    )
    assert result["satisfied"] is True
    assert result["change"]["elementId"] == "el-found"
    assert seen[0] == "element-appeared"
