"""The arithmetic of typing, tested where a live desktop cannot show it.

Whether text arrives at the right speed is invisible on screen — it either looks
about right or it looks about wrong, and neither is a measurement. These are the
assertions that make the duration a promise rather than a hope.
"""

from __future__ import annotations

import pytest

from desktop_service import cadence


def total_ms(plan: list[cadence.Keystroke]) -> int:
    return sum(stroke.delay_ms for stroke in plan)


def test_the_plan_types_exactly_what_it_was_given():
    text = "Hey — did you see this?\n\nSecond line, with punctuation."
    assert "".join(stroke.text for stroke in cadence.plan(text, seed=1)) == text


def test_words_arrive_whole_because_that_is_how_dictation_does_it():
    plan = cadence.plan("type these words please", seed=1)
    assert [stroke.text for stroke in plan] == ["type ", "these ", "words ", "please"]


def test_the_duration_matches_the_estimate_a_caller_planned_around():
    """A caller sets its timeout from the estimate. The plan must honour it.

    Unnormalised jitter overruns as often as it underruns, which is fine for one
    message and useless for deciding how long to wait for one.
    """
    text = "a message of some reasonable length, with a comma and a full stop."
    for seed in range(20):
        planned = total_ms(cadence.plan(text, seed=seed))
        estimate = cadence.estimate_ms(text)
        assert abs(planned - estimate) < estimate * 0.05


def test_seventy_words_a_minute_is_actually_seventy_words_a_minute():
    # Five characters per word *including* the space it is followed by, which is
    # what every words-per-minute figure has meant since typewriters.
    text = "abcd " * 70
    minutes = cadence.estimate_ms(text, wpm=70) / 60_000
    assert 0.95 < minutes < 1.15


def test_a_typist_slows_at_a_full_stop():
    plan = cadence.plan("word word. word word", seed=3)
    after_stop = plan[2].delay_ms
    ordinary = plan[1].delay_ms
    assert after_stop > ordinary * 2


def test_the_first_word_does_not_wait():
    assert cadence.plan("anything at all", seed=1)[0].delay_ms == 0


def test_nothing_to_type_is_a_plan_with_no_steps():
    assert cadence.plan("") == []


@pytest.mark.parametrize("wpm", [cadence.MIN_WPM, cadence.DEFAULT_WPM, cadence.MAX_WPM])
def test_every_permitted_speed_produces_a_usable_plan(wpm):
    plan = cadence.plan("a few words to type", wpm=wpm, seed=2)
    assert "".join(stroke.text for stroke in plan) == "a few words to type"
    assert total_ms(plan) > 0
