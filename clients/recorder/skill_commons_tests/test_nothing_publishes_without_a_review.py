"""The gate's first claim: the publish path is unreachable without the second file.

Not "publishes with a warning", not "publishes and records that the review was
missing". Unreachable. The assertion that carries this file is not on the return
value — it is on what the forge was made to do, which is nothing. No branch was
cut, nothing was committed or pushed, no request was opened and no file was
written into the checkout. A design where the skill reaches
the remote and the review does not is a design where somebody merges the half
that arrived.

There is no flag in either of these paths, and there is no test here for one,
because there is nothing to test: an override is the feature that would make
every other sentence in this suite decorative.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from skill_commons import Opinion, Panel, Review
from skill_commons.curation import Curator, Ledger, OBTAINED_SCREEN
from skill_commons.forge import ForgeError, GitHubForge

from skill_commons_tests.conftest import a_route


@pytest.fixture
def checkout(tmp_path: Path) -> Path:
    made = tmp_path / "checkout"
    made.mkdir(exist_ok=True)
    return made


@pytest.fixture
def forge_at(checkout: Path, forge) -> GitHubForge:
    return GitHubForge(
        repo="owner/repo",
        checkout=checkout,
        submitter="installation-3f9a",
        run=forge,
    )


# -- the gate --------------------------------------------------------------


def test_a_machine_with_no_reader_configured_proposes_nothing(
    forge_at, forge, tmp_path: Path
):
    """The default that would have been convenient is the one that publishes."""
    curator = Curator(
        forge=forge_at,
        ledger=Ledger(tmp_path / "state" / "submissions.jsonl"),
        enabled=True,
    )

    outcome = curator.submit(a_route())

    assert not outcome.admitted
    assert outcome.proposed is None
    assert forge.wrote == ()
    assert OBTAINED_SCREEN in [screen.name for screen in outcome.refusals]


# -- the forge, which is reached by more than the gate ---------------------


def test_the_forge_will_not_cut_a_branch_without_a_review(forge_at, forge):
    """The second lock, on the path that actually publishes.

    The curator will not call this without a passing review. This assertion is
    about the caller written a year from now that reaches the forge directly —
    the reason the check is in the function that pushes rather than only in the
    one that decides.
    """
    with pytest.raises(ForgeError) as refused:
        forge_at.propose(a_route())

    assert "REVIEW.md" in str(refused.value)
    assert forge.calls == []


def test_a_review_that_refused_is_not_a_review_that_permits(forge_at, forge):
    no = Review((Opinion(reviewer="reader-a", passed=False, findings=("a name",)),))
    with pytest.raises(ForgeError):
        forge_at.propose(a_route(), read_by=no)
    assert forge.calls == []


def test_an_empty_panel_is_not_a_unanimous_one(forge_at, forge):
    """`all(())` is the most expensive default available in a gate.

    A `Review` with nothing in it is what a panel with no reviewers would
    produce if `passed` were written the obvious way, and it would publish
    everything while every test above still passed.
    """
    assert not Review(()).passed
    with pytest.raises(ForgeError):
        forge_at.propose(a_route(), read_by=Review(()))
    assert forge.calls == []
    assert not Panel().reviewers


# -- what a refusal says ---------------------------------------------------


def test_the_refusal_names_the_file_that_is_missing(forge_at):
    """A refusal nobody can act on is a refusal that gets worked around."""
    with pytest.raises(ForgeError) as refused:
        forge_at.propose(a_route())
    said = str(refused.value)
    assert "REVIEW.md" in said
    assert "discord-read-latest-direct-message" in said


def test_nothing_was_written_into_the_checkout(forge_at, checkout: Path):
    with pytest.raises(ForgeError):
        forge_at.propose(a_route())
    assert list(checkout.iterdir()) == []
