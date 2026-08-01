"""The acting layer's contract, tested without a desktop.

What matters here is not whether AT-SPI can click a button — the live test covers that.
It is whether the layer around it tells the truth: which tier answered, what changed, and
what it did not do when it stopped early.
"""

from __future__ import annotations

from desktop_service import actions, errors, settle, state
from tests.test_settle import Clock, script, snapshot, window


def steady(snap: state.Snapshot):
    return lambda: snap


def test_a_successful_action_names_the_tier_that_answered() -> None:
    log = actions.ActionLog()
    result = actions.perform(
        "focusWindow",
        "win-a",
        [actions.Attempt("accessibility", lambda: True)],
        steady(snapshot(1, window("win-a"))),
        log,
        quiet_ms=0,
        ceiling_ms=0,
    )
    assert result["ok"] is True
    assert result["backend"] == "accessibility"
    assert result["fallbacksUsed"] == []
    assert "error" not in result


def test_a_fallback_that_works_is_still_reported_as_a_fallback() -> None:
    """A degraded path must never look blessed."""
    log = actions.ActionLog()
    result = actions.perform(
        "focusWindow",
        "win-a",
        [
            actions.Attempt("accessibility", lambda: False),
            actions.Attempt("compositor", lambda: True),
        ],
        steady(snapshot(1, window("win-a"))),
        log,
        quiet_ms=0,
        ceiling_ms=0,
    )
    assert result["ok"] is True
    assert result["backend"] == "compositor"
    assert result["fallbacksUsed"] == ["accessibility"]


def test_an_action_no_tier_can_do_fails_and_says_which_tiers_refused() -> None:
    log = actions.ActionLog()
    result = actions.perform(
        "invokeElement",
        "el-a",
        [
            actions.Attempt("accessibility", lambda: False),
            actions.Attempt("compositor", lambda: False),
        ],
        steady(snapshot(1, window("win-a"))),
        log,
        quiet_ms=0,
        ceiling_ms=0,
    )
    assert result["ok"] is False
    assert result["error"]["code"] == errors.ErrorCode.ACTION_NOT_SUPPORTED
    assert "accessibility" in result["error"]["message"]
    assert "compositor" in result["error"]["message"]


def test_every_result_carries_the_fields_a_caller_would_otherwise_re_inspect_for() -> None:
    log = actions.ActionLog()
    result = actions.perform(
        "focusWindow",
        "win-a",
        [actions.Attempt("accessibility", lambda: True)],
        steady(snapshot(1, window("win-a"))),
        log,
        quiet_ms=0,
        ceiling_ms=0,
    )
    for required in ("actionId", "ok", "backend", "fallbacksUsed", "durationMs"):
        assert required in result
    effects = result["observedEffects"]
    assert effects["fromRevision"] == 1
    assert "changes" in effects and "partial" in effects
