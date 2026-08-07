"""A reader objects to a waypoint, and the route stops on the machine it was learned on.

`Private channels` is a piece of Discord. `Alice Nichols` is a person, and the
shape check in `skill.py` admits it — it is three words of letters and a space,
which is what a landmark looks like. That is not an oversight in the shape check
and its docstring says so: it is the reason a submission is a pair, and now the
reason there is a reader in front of the forge.

Three things are asserted about a refusal, and the third is the one a gate gets
wrong on its own.

Nothing left. Nothing was committed, pushed or opened, so there is no branch and
no request to close.

The refusal names the waypoint, out loud, to the caller. A refusal that said
only "no" is one somebody re-runs until it says yes.

And the ledger does not name it. The file this machine keeps forever records
that the review screen said no and never what it read — because a gate that
wrote *"refused: Alice Nichols"* into a permanent log would have taken the one
string the whole package exists to keep off other people's machines and written
it down, helpfully, in the course of protecting it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from skill_commons import Panel, Step
from skill_commons.curation import Curator, Ledger, REVIEW_SCREEN, refusals_in
from skill_commons.forge import GitHubForge

from skill_commons_tests.conftest import FakeReviewer, a_route

PERSON = "Alice Nichols"


def a_route_with_somebody_in_it():
    """The Discord route, with a person's name where a landmark goes."""
    steps = list(a_route().steps)
    steps[3] = Step(
        ordinal=4, method="describeElement", role="list", landmark=PERSON
    )
    return a_route(steps=tuple(steps))


@pytest.fixture
def ledger(tmp_path: Path) -> Ledger:
    return Ledger(tmp_path / "state" / "skill-submissions.jsonl")


@pytest.fixture
def checkout(tmp_path: Path) -> Path:
    made = tmp_path / "checkout"
    made.mkdir(exist_ok=True)
    return made


@pytest.fixture
def objector() -> FakeReviewer:
    return FakeReviewer("reader-a", objects_to=PERSON)


@pytest.fixture
def curator(forge, ledger, checkout: Path, objector: FakeReviewer) -> Curator:
    return Curator(
        forge=GitHubForge(
            repo="owner/repo",
            checkout=checkout,
            submitter="installation-3f9a",
            run=forge,
        ),
        ledger=ledger,
        panel=Panel(objector),
        enabled=True,
    )


def test_the_shape_check_lets_a_persons_name_through(objector):
    """Stated as a test so the layering is not mistaken for a bug found later."""
    assert a_route_with_somebody_in_it().steps[3].landmark == PERSON


def test_a_skill_a_reader_objected_to_is_not_proposed(curator, forge):
    outcome = curator.submit(a_route_with_somebody_in_it())

    assert not outcome.admitted
    assert outcome.proposed is None
    assert REVIEW_SCREEN in [screen.name for screen in outcome.refusals]


def test_nothing_leaves_the_machine(curator, forge, checkout: Path):
    curator.submit(a_route_with_somebody_in_it())

    assert forge.wrote == ()
    assert list(checkout.iterdir()) == []


def test_the_refusal_names_the_waypoint_it_objected_to(curator):
    outcome = curator.submit(a_route_with_somebody_in_it())
    assert PERSON in outcome.reason


def test_the_ledger_records_the_refusal_and_not_the_name(curator, ledger):
    curator.submit(a_route_with_somebody_in_it())

    written = ledger.path.read_text()
    assert "discord-read-latest-direct-message" in written
    assert PERSON not in written
    assert "Nichols" not in written
    assert REVIEW_SCREEN in written

    refused = list(refusals_in(ledger))
    assert len(refused) == 1
    assert REVIEW_SCREEN in refused[0]["refused_for"]


def test_a_clean_route_through_the_same_reader_still_goes(curator, forge):
    """The objector is not a reader that says no to everything."""
    outcome = curator.submit(a_route())
    assert outcome.admitted
    assert outcome.proposed == 200
