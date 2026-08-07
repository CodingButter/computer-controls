"""Silence is not consent.

The failure this file exists for does not look like a failure. A credential
expires, a model is retired, a rate limit is reached on a Tuesday afternoon —
and a gate written the easy way starts publishing everything, because nothing
objected. Every skill that month was proposed without a reader, and the ledger
says the review screen passed.

So an unobtainable review is refused, and it is refused *differently*. The two
outcomes have different screen names and different sentences, and the test that
matters most here is the one asserting they are not the same string: an operator
reading a week of refusals has to be able to tell "this machine's routes are bad"
from "this machine has not been able to reach a reader since Thursday". A single
name for both would hide the second inside the first.

An answer this gate cannot read is the same absence as no answer at all. A model
that replies with an apology, an empty string, or a verdict that is not one of
the two words it was asked for has not reviewed anything, and reading a "maybe"
generously is how a gate becomes a formality.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from skill_commons import Panel, Unobtainable
from skill_commons.curation import (
    Curator,
    Ledger,
    OBTAINED_SCREEN,
    REVIEW_SCREEN,
)
from skill_commons.forge import GitHubForge
from skill_commons.reviewer import CommandReviewer

from skill_commons_tests.conftest import FakeReviewer, a_route

PERSON = "Alice Nichols"


@pytest.fixture
def ledger(tmp_path: Path) -> Ledger:
    return Ledger(tmp_path / "state" / "skill-submissions.jsonl")


@pytest.fixture
def checkout(tmp_path: Path) -> Path:
    made = tmp_path / "checkout"
    made.mkdir(exist_ok=True)
    return made


@pytest.fixture
def curator_with(forge, ledger, checkout: Path):
    def build(*readers) -> Curator:
        return Curator(
            forge=GitHubForge(
                repo="owner/repo",
                checkout=checkout,
                submitter="installation-3f9a",
                run=forge,
            ),
            ledger=ledger,
            panel=Panel(*readers),
            enabled=True,
        )

    return build


# -- the absence -----------------------------------------------------------


def test_a_reader_that_could_not_be_reached_does_not_admit_anything(
    curator_with, forge
):
    curator = curator_with(
        FakeReviewer("reader-a", unobtainable="the credential is not installed")
    )

    outcome = curator.submit(a_route())

    assert not outcome.admitted
    assert outcome.proposed is None
    assert forge.wrote == ()


def test_the_absence_is_recorded_as_its_own_screen(curator_with, ledger):
    curator = curator_with(FakeReviewer("reader-a", unobtainable="rate limited"))
    outcome = curator.submit(a_route())

    refused = [screen.name for screen in outcome.refusals]
    assert refused == [OBTAINED_SCREEN]
    assert REVIEW_SCREEN not in [screen.name for screen in outcome.screens]
    assert OBTAINED_SCREEN in ledger.path.read_text()


def test_the_two_refusals_do_not_say_the_same_thing(curator_with):
    """The assertion the whole file is for."""
    unreachable = curator_with(
        FakeReviewer("reader-a", unobtainable="the model is not reachable")
    ).submit(a_route())
    objected = curator_with(
        FakeReviewer("reader-a", objects_to="Private channels")
    ).submit(a_route())

    assert not unreachable.admitted and not objected.admitted
    assert unreachable.reason != objected.reason
    assert "Silence is not consent" in unreachable.reason
    assert [screen.name for screen in unreachable.refusals] != [
        screen.name for screen in objected.refusals
    ]


def test_one_reader_being_down_does_not_quietly_leave_one_reader(
    curator_with, forge
):
    """Two readers configured, one unreachable: that is not a panel of one.

    A gate that carried on here would go on printing "two readers agreed" while
    asking one, and nothing in the record would say when it stopped being true.
    """
    outcome = curator_with(
        FakeReviewer("reader-a"),
        FakeReviewer("reader-b", unobtainable="the model is not reachable"),
    ).submit(a_route())

    assert not outcome.admitted
    assert forge.wrote == ()


# -- an answer that is not an answer ---------------------------------------


def _answered(printed: str) -> CommandReviewer:
    return CommandReviewer(
        name="reader-a",
        argv=("model", "--quiet"),
        run=lambda argv, prompt: (0, printed, ""),
    )


@pytest.mark.parametrize(
    "printed",
    [
        "",
        "I'm sorry, I can't help with that.",
        '{"verdict": "maybe", "findings": []}',
        '{"verdict": "", "findings": []}',
        '{"findings": []}',
        "not json at all {",
    ],
)
def test_an_answer_this_gate_cannot_read_is_not_a_yes(printed):
    with pytest.raises(Unobtainable):
        _answered(printed).read("# a skill")


def test_a_command_that_failed_is_not_a_yes():
    reviewer = CommandReviewer(
        name="reader-a",
        argv=("model",),
        run=lambda argv, prompt: (1, "", "401 unauthorized"),
    )
    with pytest.raises(Unobtainable) as absent:
        reviewer.read("# a skill")
    assert "401" in str(absent.value)


def test_a_command_that_is_not_installed_is_not_a_yes():
    def missing(argv, prompt):
        raise FileNotFoundError("no such file or directory: model")

    with pytest.raises(Unobtainable):
        CommandReviewer(name="reader-a", argv=("model",), run=missing).read("# a")


def test_a_refusal_with_nothing_attached_still_refuses():
    """The safe direction is never the one that turns a missing field into a yes."""
    opinion = _answered('{"verdict": "refuse"}').read("# a skill")
    assert not opinion.passed
    assert opinion.findings


def test_a_pass_is_only_the_word_pass():
    assert _answered('{"verdict": "PASS", "findings": []}').read("# a").passed
