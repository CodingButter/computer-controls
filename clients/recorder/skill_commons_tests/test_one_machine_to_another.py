"""The whole feature, end to end, in the only shape that matters.

Every other file in this suite proves one joint. This one proves the claim the
issue actually makes: a route one machine worked out is a route another machine
can be handed, and a route carrying something read off a screen is not.

The two paths are asserted together and deliberately. A pipeline that admits the
clean route is half a proof — the interesting half is that the refused one stops
somewhere a person can point at, leaves a record saying which screen said no,
and does not appear on the far end. A gate nobody can show refusing is a gate
nobody should trust.

The trip is proved twice, because there are two people who can take it. A
maintainer's machine reaches the commons through the forge, with a checkout and
a token. Everybody else presses publish, sends two rendered documents to the
project's service, and fetches back what was merged — no account, no git. Both
end at the same place: a folder on a second machine holding a route that says it
is advisory.

What is faked here is the forge, the service, and nothing else. The screens, the
renderer, the header writer, the folder layout and the registry are the real
ones, because a test that mocked any of them would be proving that the mock
agrees with itself.
"""

from __future__ import annotations

from pathlib import Path

import pytest


from skill_commons import Fetcher, NotPublishable, Publisher, Step, Verification, render
from skill_commons.curation import Curator, Ledger, refusals_in
from skill_commons.forge import GitHubForge
from skill_commons.registry import SkillRegistry, write_pair

from skill_commons_tests.conftest import a_route


@pytest.fixture
def machine(tmp_path: Path, forge):
    """One machine that derives routes, with publishing switched on."""
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    ledger = Ledger(tmp_path / "submissions.jsonl")
    curator = Curator(
        GitHubForge(
            repo="owner/repo",
            checkout=checkout,
            submitter="installation-3f9a",
            run=forge,
        ),
        ledger,
        enabled=True,
    )
    return curator, ledger, checkout


def test_a_route_one_machine_derived_is_one_another_machine_can_be_handed(
    machine, tmp_path: Path
):
    """The claim in the issue, start to finish.

    Machine A derives a route and submits it. The gate screens it, the forge
    opens a proposal, and a person merges — which is modelled here by the pair
    landing in the commons, because a merge is the one step in this pipeline
    that is deliberately not automatable. Machine B then reads that folder and
    gets back the route, with the version it was verified against still on it.
    """
    curator, _, _ = machine
    derived = a_route()

    submission = curator.submit(derived)
    assert submission.admitted
    assert submission.proposed == 200

    # The merge: a human read both halves and said yes.
    merged = tmp_path / "commons"
    merged.mkdir()
    write_pair(merged, derived)

    # Machine B, which has never seen machine A.
    registry = SkillRegistry(merged)
    handed = registry.get("discord-read-latest-direct-message")

    assert handed is not None
    assert handed.app == "discord"
    assert handed.app_version_verified == "1.0.151"
    # The route itself, not merely its name: every step machine A took.
    assert "`Private channels`" in handed.instructions
    assert "`setAttention`" in handed.instructions
    # And the thing every consuming agent has to be told, on the route itself.
    assert "advisory" in handed.instructions


def test_a_person_can_do_the_same_trip_with_a_button_and_no_account(
    service, tmp_path: Path
):
    """The same journey, taken by somebody who has never used `git`.

    The path above is the machine's: a curator with publishing switched on, a
    checkout, and a forge that runs `gh`. This one is the person's. They read
    the rendered skill and its review in full, press publish once, and the
    bytes go to the project's service — no account, no token, no checkout. A
    person merges, as before, and a second person on a second machine fetches
    what came out, gets the route and the review, and can put it back.
    """
    derived = a_route()
    publisher = Publisher(service)

    shown = publisher.preview(derived)
    receipt = publisher.publish(shown)

    assert receipt.accepted
    assert service.last["document"] == shown.document

    # The merge: a human read both halves and said yes. What lands in the
    # repository is what the service was given, which is what was on screen.
    merged = tmp_path / "commons"
    merged.mkdir()
    (merged / derived.name).mkdir()
    (merged / derived.name / "SKILL.md").write_text(service.last["document"])
    (merged / derived.name / "REVIEW.md").write_text(service.last["review"])

    # The far end, fetching rather than checking out.
    here = tmp_path / "fetched"
    here.mkdir()
    fetcher = Fetcher(here, _PublishedFolder(merged))

    assert fetcher.available() == (derived.name,)
    got = fetcher.fetch(derived.name)

    handed = SkillRegistry(here).get(derived.name)
    assert handed is not None
    assert "`Private channels`" in handed.instructions
    assert "advisory" in handed.instructions
    assert (got.path / "REVIEW.md").read_text() == shown.review

    # And it can leave again, taking nothing else with it.
    fetcher.remove(derived.name)
    assert SkillRegistry(here).list() == ()


class _PublishedFolder:
    """The merged commons, read as the published set.

    A folder rather than a fake: the point of this file is that as few things
    as possible are pretend, and after a merge the published set *is* a
    directory of pairs.
    """

    where = "owner/repo@main"

    def __init__(self, root: Path) -> None:
        self.root = root

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(one.name for one in self.root.iterdir()))

    def read(self, name: str) -> tuple[str, str]:
        folder = self.root / name
        return (
            (folder / "SKILL.md").read_text(),
            (folder / "REVIEW.md").read_text(),
        )


def test_the_agent_on_the_far_end_finds_it_by_asking_for_the_task(
    machine, tmp_path: Path
):
    """Handed is no use if it can only be found by a name nobody knows.

    An agent facing a Discord window does not know the slug. It knows what it is
    trying to do.
    """
    curator, _, _ = machine
    curator.submit(a_route())

    merged = tmp_path / "commons"
    merged.mkdir()
    write_pair(merged, a_route())

    hits = SkillRegistry(merged).search("read a direct message in discord")
    assert [hit.entry.name for hit in hits] == ["discord-read-latest-direct-message"]


def test_content_cannot_be_carried_into_a_skill_in_the_first_place(machine):
    """Where the content-free claim is actually enforced: construction.

    There is no field on a skill an agent can write a sentence into, so the
    ordinary route for an address to reach the commons — somebody putting one in
    a description — does not exist. A landmark is the only free-ish text, and it
    is shape-checked.
    """
    with pytest.raises(NotPublishable):
        a_route(steps=(
            Step(ordinal=1, method="census"),
            Step(ordinal=2, method="setAttention", role="window",
                 landmark="12 Rowan Street"),
        ))


def test_a_pair_that_carried_content_anyway_is_refused_before_it_is_proposed(
    machine, monkeypatch, tmp_path: Path
):
    """The second lock, and the reason there is one.

    The test above is the real defence, and it is a defence against the mistakes
    anybody anticipated. This one asks what happens if the renderer itself ever
    leaks — a template that grows a field, a future amendment kind that quotes
    something. The gate does not screen the dataclass it was handed; it screens
    the text that would be published, so a leak introduced anywhere between the
    structure and the file is still refused, and refused *here*, on the machine
    that derived the route, before a copy exists anywhere else.
    """
    curator, ledger, _ = machine
    leaky = lambda skill: render(skill).replace(
        "No element ids", "Ask at 12 Rowan Street. No element ids"
    )
    monkeypatch.setattr("skill_commons.curation.render", leaky)

    submission = curator.submit(a_route())

    assert not submission.admitted
    assert submission.proposed is None
    failed = [screen for screen in submission.screens if not screen.passed]
    assert [screen.name for screen in failed] == ["content-free"]

    # And nothing exists for a far end to read.
    merged = tmp_path / "commons"
    merged.mkdir()
    assert SkillRegistry(merged).list() == ()


def test_a_refusal_leaves_a_record_naming_the_screen_and_nothing_else(machine):
    """What the person auditing this machine gets to see.

    The reason names the screen. It does not quote what the screen found — a
    ledger that copied the address out of the skill to explain why the address
    could not be published would be the leak, written down and dated.
    """
    curator, ledger, _ = machine
    # A route that worked once: a candidate, not yet a skill.
    once = a_route(verification=Verification(
        app_version="1.0.151", when="2026-08-05", successes=1
    ))

    submission = curator.submit(once)
    assert not submission.admitted
    assert submission.proposed is None

    (record,) = list(refusals_in(ledger))
    assert record["skill"] == "discord-read-latest-direct-message"
    failed = [screen for screen in record["screens"] if not screen["passed"]]
    assert [screen["name"] for screen in failed] == ["recurrence"]


def test_the_pipeline_has_no_step_that_admits_a_skill_without_a_person(machine):
    """The absence the whole design rests on.

    Nothing an agent holds can merge. The forge exposes no such call, and this
    asserts it against the object the curator was actually given rather than
    against the class — which is where a convenience method would get added.
    """
    curator, _, _ = machine
    surface = {name for name in dir(curator.forge) if not name.startswith("_")}
    assert "merge" not in surface
    assert "admit" not in surface
    assert "approve" not in surface


def test_a_skill_for_a_password_manager_is_refused_before_it_is_ever_shaped():
    """The earliest refusal in the pipeline, and the cheapest.

    Not a screen: a construction. A route through a password manager cannot be
    built into a Skill at all, so there is no object for a later stage to be
    talked into publishing.
    """
    with pytest.raises(NotPublishable):
        a_route(app="1password")
