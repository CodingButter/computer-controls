"""The acting layer's contract, tested without a desktop.

What matters here is not whether AT-SPI can click a button — the live test covers that.
It is whether the layer around it tells the truth: which tier answered, what changed, and
what it did not do when it stopped early.
"""

from __future__ import annotations

import threading

import pytest

from desktop_service import actions, errors, holds, identity, settle, state
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


class Writer(threading.Thread):
    """One client's write, with a hand on the pause button.

    Real interleaving happens because a paced write is long. A test cannot wait
    around for that, so the attempt blocks until the test lets it go — which
    puts the second writer inside the window the first one is still in.
    """

    def __init__(self, element_id: str, client_id: str, log: actions.ActionLog) -> None:
        super().__init__(daemon=True)
        self.element_id = element_id
        self.client_id = client_id
        self.log = log
        self.inside = threading.Event()
        self.may_finish = threading.Event()
        self.ran = False
        self.result: dict | None = None
        self.refusal: errors.DesktopError | None = None

    def attempt(self) -> bool:
        self.ran = True
        self.inside.set()
        self.may_finish.wait(5)
        return True

    def run(self) -> None:
        with identity.bound(self.client_id):
            try:
                self.result = actions.perform(
                    "typeText",
                    self.element_id,
                    [actions.Attempt("accessibility", self.attempt)],
                    steady(snapshot(1, window("win-a"))),
                    self.log,
                    quiet_ms=0,
                    ceiling_ms=0,
                    client_id=self.client_id,
                )
            except errors.DesktopError as refused:
                self.refusal = refused


def test_a_second_writer_on_a_held_element_is_refused_and_never_types() -> None:
    """The whole issue: two writers into one field, one of them stopped early."""
    log = actions.ActionLog()
    first = Writer("el-a", "cl-one", log)
    second = Writer("el-a", "cl-two", log)

    first.start()
    assert first.inside.wait(5), "the first writer never started"
    second.start()
    second.join(5)

    assert second.refusal is not None
    assert second.refusal.code == errors.ErrorCode.ELEMENT_HELD
    assert second.refusal.detail["heldBy"] == "cl-one"
    # Nothing was typed by the refused caller. A refusal that still inserts a
    # word is the corruption this rule exists to prevent, wearing an error.
    assert second.ran is False

    first.may_finish.set()
    first.join(5)
    assert first.result["ok"] is True
    assert holds.holder("el-a") is None


def test_two_writers_in_different_fields_run_at_the_same_time() -> None:
    """Ownership is per element. Serializing an application would break the point.

    The barrier is the assertion: it only clears if both writes are inside
    their attempts at once, so an ownership rule that was too wide would hang
    here rather than pass quietly.
    """
    log = actions.ActionLog()
    both_inside = threading.Barrier(2, timeout=5)

    def worker(element_id: str, client_id: str, out: dict) -> None:
        def attempt() -> bool:
            both_inside.wait()
            return True

        with identity.bound(client_id):
            out[client_id] = actions.perform(
                "typeText",
                element_id,
                [actions.Attempt("accessibility", attempt)],
                steady(snapshot(1, window("win-a"))),
                log,
                quiet_ms=0,
                ceiling_ms=0,
                client_id=client_id,
            )

    results: dict = {}
    threads = [
        threading.Thread(target=worker, args=("el-a", "cl-one", results), daemon=True),
        threading.Thread(target=worker, args=("el-b", "cl-two", results), daemon=True),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)

    assert not [t for t in threads if t.is_alive()], "the two writes did not overlap"
    assert results["cl-one"]["ok"] is True
    assert results["cl-two"]["ok"] is True


def test_the_element_is_given_back_when_the_write_fails() -> None:
    """A field nobody could type into must not stay owned by the attempt that tried."""
    log = actions.ActionLog()
    result = actions.perform(
        "typeText",
        "el-a",
        [actions.Attempt("accessibility", lambda: False)],
        steady(snapshot(1, window("win-a"))),
        log,
        quiet_ms=0,
        ceiling_ms=0,
        client_id="cl-one",
    )
    assert result["ok"] is False
    assert holds.holder("el-a") is None


def test_the_element_is_given_back_when_the_write_raises() -> None:
    log = actions.ActionLog()

    def explode() -> bool:
        raise errors.DesktopError(errors.ErrorCode.TIMEOUT, "the toolkit did not answer")

    with pytest.raises(errors.DesktopError):
        actions.perform(
            "typeText",
            "el-a",
            [actions.Attempt("accessibility", explode)],
            steady(snapshot(1, window("win-a"))),
            log,
            quiet_ms=0,
            ceiling_ms=0,
            client_id="cl-one",
        )
    assert holds.holder("el-a") is None


def test_an_action_that_is_not_a_write_owns_nothing() -> None:
    """Two callers focusing one window is not a collision worth refusing."""
    log = actions.ActionLog()

    def focus(client_id: str) -> dict:
        with identity.bound(client_id):
            return actions.perform(
                "focusWindow",
                "win-a",
                [actions.Attempt("accessibility", lambda: True)],
                steady(snapshot(1, window("win-a"))),
                log,
                quiet_ms=0,
                ceiling_ms=0,
                client_id=client_id,
            )

    assert focus("cl-one")["ok"] is True
    assert focus("cl-two")["ok"] is True
    assert holds.holder("win-a") is None
