"""What a skill may know, and what the file it becomes may not.

The episode recorder already has a test with this shape, and it is worth saying
why there are two rather than one. `test_nothing_sensitive_is_filed.py` asks
whether a *finding* — a structure with no field a sentence fits in — can be
talked into carrying one. The answer there is easy because the structure does
almost all of the work.

A skill is harder, and it is harder in an interesting way: a skill has to carry
words the application chose, or it is a route to nowhere. `Private channels` is
the whole value of the Discord route, and there is no vocabulary anybody can
enumerate that contains it. So the question this file asks is narrower and more
honest than the recorder's: given that one field must be open, does everything
around it stay shut, and does the open field refuse every shape it can be proved
not to need?

The last test here is the one that matters most, because it fails on purpose:
it records that a person's name passes the shape check, so that nobody reads
this suite as a proof the gate is mechanical. It is not. The screens narrow what
a human has to look at. The human is the gate.
"""

from __future__ import annotations

import pytest

from episode_recorder import Author

from skill_commons import (
    NotPublishable,
    Skill,
    Step,
    Verification,
    render,
    render_review,
    scan,
    validate,
)

SECRET = "hunter2-correct-horse"
PERSON = "Alice Nichols"
ADDRESS = "12 Rowan Street"
MESSAGE = "meet me at six under the mat"


def a_skill(**changed) -> Skill:
    """The Discord route, which is the one the whole feature came from."""
    fields = dict(
        app="discord",
        task="read-latest-direct-message",
        steps=(
            Step(ordinal=1, method="census"),
            Step(ordinal=2, method="setAttention", role="window"),
            Step(ordinal=3, method="describeElement", role="document text"),
            Step(ordinal=4, method="describeElement", role="list",
                 landmark="Private channels"),
            Step(ordinal=5, method="describeElement", role="list item"),
        ),
        verification=Verification(app_version="1.0.151", when="2026-08-05", successes=3),
        author=Author(client_id="client-7", label="hub"),
    )
    fields.update(changed)
    return Skill(**fields)


def published(skill: Skill) -> str:
    """Everything about this skill that would end up on a public server."""
    return render(skill) + "\n" + render_review(skill)


# -- the shapes that are refused outright ---------------------------------


def test_a_password_is_not_a_landmark():
    with pytest.raises(NotPublishable):
        Step(ordinal=1, method="describeElement", landmark=SECRET)


def test_a_message_is_not_a_landmark():
    """Four words with a preposition in them is a sentence, not a label."""
    with pytest.raises(NotPublishable):
        Step(ordinal=1, method="describeElement", landmark=MESSAGE)


def test_an_address_is_not_a_landmark():
    with pytest.raises(NotPublishable):
        Step(ordinal=1, method="describeElement", landmark=ADDRESS)


def test_an_element_id_is_not_a_landmark():
    """The shape that would make a route work exactly once."""
    with pytest.raises(NotPublishable):
        Step(ordinal=1, method="describeElement", landmark="elem-4f19c2b0")


def test_a_role_nobody_uses_is_refused():
    with pytest.raises(NotPublishable):
        Step(ordinal=1, method="describeElement", role="direct message")


def test_a_method_that_is_a_sentence_is_refused():
    with pytest.raises(NotPublishable):
        Step(ordinal=1, method="read the message from alice")


def test_a_task_named_after_a_person_is_refused():
    """A slug is lower case and hyphenated; a name typed in is neither."""
    with pytest.raises(NotPublishable):
        a_skill(task="read Alice's message")


# -- what a legitimate route is still allowed to say ----------------------


def test_the_structure_a_route_needs_survives():
    skill = a_skill()
    assert skill.name == "discord-read-latest-direct-message"
    assert skill.landmarks == ("Private channels",)
    assert [step.method for step in skill.steps][:2] == ["census", "setAttention"]


def test_a_clean_route_passes_every_screen():
    skill = a_skill()
    verdict = validate(skill, rendered=published(skill))
    assert verdict.admitted, verdict.reason


# -- the rendered pair, which is the thing that actually leaves ------------


def test_nothing_secret_reaches_the_published_files():
    text = published(a_skill())
    for forbidden in (SECRET, PERSON, ADDRESS, MESSAGE, "hunter2"):
        assert forbidden not in text


def test_a_link_in_the_published_text_is_refused():
    """Scanned on the rendered text, because the rendered text is what ships."""
    verdict = validate(a_skill(), rendered="see https://example.com/u/12345")
    assert not verdict.admitted
    assert "link" in verdict.reason


def test_a_token_shaped_string_in_the_published_text_is_refused():
    verdict = validate(
        a_skill(), rendered="ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
    )
    assert not verdict.admitted
    assert "key" in verdict.reason


def test_an_email_address_in_the_published_text_is_refused():
    verdict = validate(a_skill(), rendered="filed by alice.nichols@example.com")
    assert not verdict.admitted
    assert "email" in verdict.reason


@pytest.mark.parametrize(
    "number", ["+1 (555) 010-4477", "555-010-4477", "15550104477"]
)
def test_a_telephone_number_in_the_published_text_is_refused(number):
    verdict = validate(a_skill(), rendered=f"call {number}")
    assert not verdict.admitted
    assert "telephone" in verdict.reason


@pytest.mark.parametrize("digits", ["1.0.151", "2026-08-05", "verified 3 times"])
def test_the_digits_a_skill_must_carry_are_not_mistaken_for_a_number(digits):
    """The version and the date are the staleness signal, and they are digits.

    A screen that refused them would be switched off within a week, and a
    screen that is switched off guards nothing. This is the assertion that
    keeps the telephone pattern from growing back into one.
    """
    assert not scan(f"last verified against {digits}")


# -- the screens that are not about text ----------------------------------


def test_a_route_that_worked_once_is_not_yet_a_skill():
    once = a_skill(
        verification=Verification(app_version="1.0.151", when="2026-08-05", successes=1)
    )
    verdict = validate(once)
    assert not verdict.admitted
    assert "incident" in verdict.reason


def test_a_route_through_a_password_manager_is_refused_whatever_it_says():
    """Nothing about this route is content. It is refused for where it goes."""
    vault = a_skill(app="bitwarden", task="read-the-selected-entry")
    verdict = validate(vault)
    assert not verdict.admitted
    assert "withholds" in verdict.reason


def test_a_route_that_names_nothing_is_refused():
    empty = a_skill(
        steps=(
            Step(ordinal=1, method="census"),
            Step(ordinal=2, method="setAttention"),
        )
    )
    verdict = validate(empty)
    assert not verdict.admitted
    assert "list of calls" in verdict.reason


def test_every_screen_is_asked_even_after_one_refuses():
    """A skill refused for two reasons is told both, or it comes back twice."""
    doomed = a_skill(
        app="keepassxc",
        verification=Verification(app_version="1.0.151", when="2026-08-05", successes=1),
    )
    verdict = validate(doomed)
    assert len(verdict.refusals) == 2


# -- the limit, recorded rather than implied ------------------------------


def test_a_persons_name_passes_the_shape_check():
    """The failure this gate does not close, written down so nobody assumes it does.

    `Alice Nichols` is two capitalised words with no digits and no punctuation.
    So is `Private Channels`. No pattern distinguishes them, and a pattern that
    claimed to would be a pattern somebody trusted. This is why a submission is
    a pair, why the review names every landmark, and why a person reads it.
    """
    step = Step(ordinal=1, method="describeElement", landmark=PERSON)
    assert step.landmark == PERSON

    skill = a_skill(steps=(step,))
    assert validate(skill, rendered=published(skill)).admitted

    # And the review puts it in front of the reviewer by name, rather than
    # leaving them to find it in the route.
    assert PERSON in render_review(skill)
    assert "reviewer decides" in render_review(skill)
