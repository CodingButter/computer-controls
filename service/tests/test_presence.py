"""The takeover rule, tested on a machine that need not have a desktop."""

from __future__ import annotations

import pytest

from desktop_service import presence


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def watch(idle=0, active="win-editor", clock=None):
    state = {"idle": idle, "active": active}
    w = presence.Watch(
        lambda: state["idle"],
        lambda: state["active"],
        now=clock or Clock(),
    )
    return w, state


def test_a_person_typing_in_the_window_we_are_writing_in_has_taken_it():
    w, _ = watch(idle=200, active="win-editor")
    assert w.took("win-editor")


def test_a_person_typing_somewhere_else_has_taken_nothing():
    # The whole thesis: an agent writing into a background field and a human
    # writing into their own are not in conflict, and treating them as if they
    # were would make the product useless.
    w, _ = watch(idle=200, active="win-chat")
    assert not w.took("win-editor")


def test_somebody_who_walked_away_is_not_holding_the_window_they_left_focused():
    w, _ = watch(idle=90_000, active="win-editor")
    assert not w.took("win-editor")


def test_a_display_server_that_cannot_report_idle_time_never_claims_a_takeover():
    # Refusing to act on absent evidence. A guard that fires when it knows
    # nothing is a guard that gets switched off.
    w, _ = watch(idle=None, active="win-editor")
    assert not w.took("win-editor")
    assert not w.reading().human_is_here


def test_a_probe_that_raises_reads_as_cannot_say_rather_than_taking_the_service_down():
    def boom():
        raise RuntimeError("the display went away")

    w = presence.Watch(boom, boom)
    look = w.reading()
    assert look.idle_ms is None
    assert look.active_window == ""
    assert not w.took("win-editor")


def test_an_unidentified_window_is_not_evidence_that_somebody_took_it():
    w, _ = watch(idle=10, active="")
    assert not w.took("")


def test_the_element_is_withheld_from_the_client_it_was_taken_from():
    w, _ = watch(idle=10, active="win-editor")
    w.withhold("el-body", "win-editor", taken_from="writer")
    held = w.holder_of("el-body")
    assert held is not None
    assert held.taken_from == "writer"
    assert held.window_id == "win-editor"


def test_a_pause_in_typing_does_not_hand_the_field_back():
    clock = Clock()
    w, state = watch(idle=10, active="win-editor", clock=clock)
    w.withhold("el-body", "win-editor", taken_from="writer")
    clock.advance(1.0)
    state["idle"] = 900  # reading, not typing
    assert w.holder_of("el-body") is not None


def test_the_field_comes_back_once_the_person_has_left_it_alone():
    clock = Clock()
    w, state = watch(idle=10, active="win-editor", clock=clock)
    w.withhold("el-body", "win-editor", taken_from="writer")
    clock.advance(presence.HANDBACK_MS / 1000 + 1)
    state["idle"] = 60_000
    assert w.holder_of("el-body") is None


def test_the_field_does_not_come_back_while_the_person_is_still_in_it():
    clock = Clock()
    w, _ = watch(idle=10, active="win-editor", clock=clock)
    w.withhold("el-body", "win-editor", taken_from="writer")
    clock.advance(600)
    assert w.holder_of("el-body") is not None


def test_an_element_nobody_took_has_no_holder():
    w, _ = watch()
    assert w.holder_of("el-body") is None


@pytest.mark.parametrize("idle", [0, presence.HUMAN_RECENT_MS])
def test_the_recency_bound_includes_its_own_edge(idle):
    w, _ = watch(idle=idle, active="win-editor")
    assert w.took("win-editor")


def test_just_past_the_recency_bound_is_absence():
    w, _ = watch(idle=presence.HUMAN_RECENT_MS + 1, active="win-editor")
    assert not w.took("win-editor")
