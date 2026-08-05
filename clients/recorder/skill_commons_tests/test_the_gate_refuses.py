"""What the gate stops, what it lets through, and what it writes down about both.

Three assertions here are the ones worth the file.

A route that has worked once never reaches the forge — not proposed and then
withdrawn, not refused by a reviewer: the forge is never called at all. Same for
a route through a password manager. The screens run on this machine, while a
refusal is still free.

The address and the telephone number never get as far as the gate, and the test
that proves it asserts on the *constructor*. That is the layering working as
designed: the shape check refuses them where a skill is built, so the content
scan over the rendered pair is a backstop for a path that no longer exists
rather than the thing doing the work. A test that let them through to the gate
would be testing a weaker lock than the one that is actually there.

And the ledger cannot quote. This is the trap the recorder's filing tests
exposed, and a gate left alone walks into it: a record that says *"refused: found
12 Rowan Street"* takes the one string the whole package exists to keep off
other people's machines and writes it into a permanent file, helpfully, in the
name of an audit trail. So the record names screens and never sentences — and
the two-sided test is that a landmark which *passed* every screen is also
absent, because a log that copied the skills it admitted would leak by a route
no refusal ever takes.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from skill_commons import NotPublishable, Step
from skill_commons.curation import (
    CAP,
    SUBMISSION_ENV,
    Curator,
    Ledger,
    refusals_in,
)
from skill_commons.forge import GitHubForge

from skill_commons_tests.conftest import a_route, another_route

SECRET = "hunter2-correct-horse"
ADDRESS = "12 Rowan Street"
PHONE = "+1 (555) 010-4477"


@pytest.fixture
def ledger(tmp_path: Path) -> Ledger:
    return Ledger(tmp_path / "state" / "skill-submissions.jsonl")


@pytest.fixture
def curator(forge, ledger, tmp_path: Path):
    checkout = tmp_path / "checkout"
    checkout.mkdir(exist_ok=True)

    def build(**changed):
        fields = dict(
            forge=GitHubForge(
                repo="owner/repo",
                checkout=checkout,
                submitter="installation-3f9a",
                run=forge,
            ),
            ledger=ledger,
            enabled=True,
        )
        fields.update(changed)
        return Curator(**fields)

    return build


# -- a clean route ---------------------------------------------------------


def test_a_route_that_passes_every_screen_is_proposed(curator, forge):
    outcome = curator().submit(a_route())
    assert outcome.admitted
    assert outcome.proposed == 200
    assert forge.argv_for("gh", "pr", "create")


def test_what_was_proposed_is_written_down(curator, ledger):
    curator().submit(a_route())
    (record,) = ledger.read()
    assert record["skill"] == "discord-read-latest-direct-message"
    assert record["admitted"] is True
    assert record["proposed"] == 200


# -- what never leaves -----------------------------------------------------


def test_a_route_that_worked_once_is_a_candidate_and_not_a_skill(curator, forge):
    """Once is an incident. The commons hands routes to strangers."""
    once = a_route()
    once = _with_successes(once, 1)
    outcome = curator().submit(once)
    assert not outcome.admitted
    assert "once is an incident" in outcome.reason
    assert forge.calls == []


def test_a_route_through_a_password_manager_is_refused_whatever_it_says(
    curator, forge
):
    outcome = curator().submit(a_route(app="bitwarden", task="read-an-entry"))
    assert not outcome.admitted
    assert "withholds" in outcome.reason
    assert forge.calls == []


@pytest.mark.parametrize(
    "read_off_the_screen",
    [ADDRESS, PHONE, SECRET, "meet me at six under the mat", "Alice's password"],
)
def test_what_was_read_off_the_screen_cannot_be_built_into_a_step(
    read_off_the_screen, forge
):
    """Refused where the skill is built, not where it is sent.

    The gate never sees these, and that is the design: a shape check on a
    structured field is a stronger lock than a scan of rendered text, so the
    scan is a backstop for a path that no longer exists. Asserting on the gate
    here would be asserting on the weaker of the two locks.
    """
    with pytest.raises(NotPublishable):
        a_route(
            steps=(
                Step(ordinal=1, method="census"),
                Step(ordinal=2, method="describeElement", role="label",
                     landmark=read_off_the_screen),
            )
        )
    assert forge.calls == []


def test_the_published_pair_is_scanned_and_not_only_the_structure(curator):
    """The backstop is wired, whether or not anything can currently reach it.

    A screen that is not run is a screen that stops working without anybody
    finding out — so the content scan runs over the rendered pair on every
    submission, and this asserts it was asked.
    """
    outcome = curator().submit(a_route())
    assert "content-free" in {screen.name for screen in outcome.screens}


def test_a_list_of_calls_with_no_landmarks_is_not_a_route(curator, forge):
    outcome = curator().submit(
        a_route(
            steps=(
                Step(ordinal=1, method="census"),
                Step(ordinal=2, method="describeElement"),
            )
        )
    )
    assert not outcome.admitted
    assert "list of calls" in outcome.reason
    assert forge.calls == []


def test_every_screen_is_answered_even_after_one_says_no(curator):
    """A skill refused for three reasons, fixed for one, is a round trip."""
    outcome = curator().submit(
        _with_successes(a_route(app="bitwarden", task="read-an-entry"), 1)
    )
    assert len(outcome.refusals) == 2
    assert {screen.name for screen in outcome.refusals} == {
        "recurrence",
        "application",
    }


# -- the record, and what it must not contain ------------------------------


def test_the_refusal_is_recorded_and_not_only_the_admission(curator, ledger):
    """A screen nobody can see working is one nobody notices has stopped."""
    curator().submit(_with_successes(a_route(), 1))
    (record,) = ledger.read()
    assert record["admitted"] is False
    assert record["refused_for"] == ["recurrence"]
    assert list(refusals_in(ledger))


def test_the_record_names_screens_and_never_sentences(curator, ledger):
    """The trap: an audit trail that helpfully quotes what it was refusing.

    The refusal here has a perfectly good English reason attached, and the
    reason is not in the file. That is deliberate and it is the general form of
    the rule: the moment a record has a field a sentence fits in, the sentence
    somebody eventually interpolates a value into fits in it too.
    """
    outcome = curator().submit(_with_successes(a_route(), 1))
    written = ledger.path.read_text()

    assert "recurrence" in written
    assert outcome.reason
    assert "once is an incident" not in written
    assert outcome.reason not in written


def test_the_ledger_does_not_copy_the_skills_it_admitted(curator, ledger):
    """The two-sided half: a log leaks by admitting, not only by refusing.

    Every landmark in an admitted skill passed every screen — which says
    nothing about whether it belongs in a permanent file on this machine. It is
    named by the skill's own name and by nothing else.
    """
    curator().submit(a_route())
    written = ledger.path.read_text()

    assert "discord-read-latest-direct-message" in written
    for landmark in ("Private channels", "describeElement", "document text"):
        assert landmark not in written


def test_a_ledger_that_cannot_be_written_does_not_lose_the_decision(
    curator, forge, tmp_path
):
    """Losing the log must not lose the action — the audit log's own ruling."""
    unwritable = tmp_path / "wall"
    unwritable.write_text("not a directory")
    broken = Ledger(unwritable / "nested" / "ledger.jsonl")

    outcome = curator(ledger=broken).submit(a_route())

    assert outcome.admitted
    assert outcome.proposed == 200
    assert broken.unwritten == 1


# -- the switch and the cap ------------------------------------------------


def test_a_machine_that_was_not_switched_on_screens_and_stays_quiet(forge, ledger):
    """Screened and recorded, so the gate can be watched before it is trusted."""
    outcome = Curator(forge, ledger, environ={}).submit(a_route())
    assert not outcome.admitted
    assert outcome.proposed is None
    assert "does not publish" in outcome.reason
    assert forge.calls == []
    assert ledger.read()


def test_the_switch_is_set_or_not_rather_than_parsed(forge, ledger):
    on = Curator(forge, ledger, environ={SUBMISSION_ENV: ""})
    assert on.enabled
    assert Curator(forge, ledger, environ={SUBMISSION_ENV: "0"}).enabled


def test_at_the_cap_the_machine_stops_proposing(curator, forge, ledger):
    """Triage happens at the source rather than in a maintainer's inbox."""
    curate = curator(cap=2)
    curate.submit(a_route())
    curate.submit(another_route())

    blocked = curate.submit(
        another_route(app="slack", task="read-a-thread")
    )
    assert not blocked.admitted
    assert "cap is 2" in blocked.reason
    assert len([r for r in ledger.read() if r["admitted"]]) == 2


def test_the_default_cap_is_small_enough_to_be_read_in_one_sitting():
    assert CAP <= 5


def _with_successes(skill, successes: int):
    from dataclasses import replace

    return replace(
        skill, verification=replace(skill.verification, successes=successes)
    )
