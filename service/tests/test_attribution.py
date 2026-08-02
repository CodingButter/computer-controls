"""Whether an action's recorded revision range actually covers what it caused.

This is the seam the delta engine will build causal attribution on. If a range is wrong
here the mistake surfaces a phase later as the agent being told its own click was news,
or — worse — being told that somebody else's window was its own doing.
"""

from __future__ import annotations

from desktop_service import actions, state
from tests.test_settle import snapshot, window


def test_the_range_starts_before_the_action_is_dispatched() -> None:
    """A toolkit that reacts synchronously must not escape its own action's range.

    The failure this guards against is subtle: stamp the first revision *after* calling
    the toolkit and a fast application's effects land at a revision the record does not
    cover. They then look like somebody else's changes.
    """
    revisions = iter([snapshot(5, window("win-a")), snapshot(6, window("win-a"), window("win-b"))])
    last = {"snap": None}

    def take() -> state.Snapshot:
        try:
            last["snap"] = next(revisions)
        except StopIteration:
            pass
        return last["snap"]

    log = actions.ActionLog()
    actions.perform(
        "invokeElement", "el-a", [actions.Attempt("accessibility", lambda: True)],
        take, log, quiet_ms=0, ceiling_ms=0,
    )
    record = log.latest()
    assert record.first_revision == 5, "the range opens at the revision before the action"
    assert record.covers(5) and record.covers(6)


def test_a_revision_outside_the_range_is_not_attributed() -> None:
    log = actions.ActionLog()
    log.record(
        actions.ActionRecord(
            action_id="act-1", method="invokeElement", target_id="el-a",
            first_revision=10, last_revision=12, partial=False,
        )
    )
    assert [r.action_id for r in log.covering(11)] == ["act-1"]
    assert log.covering(9) == []
    assert log.covering(13) == [], "a later change is news, not an aftershock"


def test_concurrent_actions_can_both_cover_a_revision() -> None:
    """Two clients acting at once genuinely both overlap a change.

    Reporting one and hiding the other would be a guess dressed as a fact. The delta
    engine gets both records and decides with causal scope, which it has and this does
    not.
    """
    log = actions.ActionLog()
    log.record(actions.ActionRecord("act-1", "invokeElement", "el-a", 4, 9, False))
    log.record(actions.ActionRecord("act-2", "focusWindow", "win-b", 7, 11, False))
    assert {r.action_id for r in log.covering(8)} == {"act-1", "act-2"}


def test_the_log_stays_bounded_in_a_long_lived_session() -> None:
    """The service is meant to outlive the client that started it."""
    log = actions.ActionLog(limit=8)
    for n in range(50):
        log.record(actions.ActionRecord(f"act-{n}", "focusWindow", "win-a", n, n, False))
    assert len(log._records) == 8
    assert log.latest().action_id == "act-49"


def test_effects_recorded_on_the_action_are_the_ones_it_reported() -> None:
    """The record and the result must not be able to disagree."""
    before = snapshot(1, window("win-a"))
    after = snapshot(2, window("win-a"), window("win-b", title="Preferences"))
    snaps = iter([before, after])
    held = {"snap": before}

    def take() -> state.Snapshot:
        try:
            held["snap"] = next(snaps)
        except StopIteration:
            pass
        return held["snap"]

    log = actions.ActionLog()
    result = actions.perform(
        "invokeElement", "el-menu", [actions.Attempt("accessibility", lambda: True)],
        take, log, quiet_ms=0, ceiling_ms=0,
    )
    assert result["observedEffects"]["changes"] == log.latest().changes
    assert [c["kind"] for c in log.latest().changes] == ["window-opened"]
