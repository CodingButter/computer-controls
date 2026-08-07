"""One submission is one skill, one branch and one pull request.

The rule reads like bookkeeping and is not. A branch carrying two skills is a
branch a reviewer approves two skills from while reading one, which is the exact
failure the whole pair-and-review design exists to prevent — and the cheapest
place to make it impossible is the function that reads the payload, before
anything has been rendered or screened.

The other half of the rule is that publishing is one call. A submission that
passes every screen produces exactly one proposal, not a proposal per retry and
not a branch left behind by a screen that failed after the branch was cut.
"""

from __future__ import annotations

import threading

import pytest

from commons_service import Publisher, Refused

from commons_service_tests.conftest import a_route, a_submission, on_the_wire


def test_a_submission_that_passes_becomes_one_pull_request(publisher, forges):
    published = publisher.publish(on_the_wire(a_submission()))

    assert published.proposed == 200
    assert published.skill == "discord-read-latest-direct-message"
    assert forges.proposals == [("discord-read-latest-direct-message", "main", "")]


def test_two_skills_in_one_submission_are_refused_by_name(publisher, forges):
    """Refused for the rule, not for a shape it happens to also break.

    The screen is named `one-skill` and says so, because a contributor told
    `shape` would go looking for a malformed field and find nothing wrong with
    either of the two perfectly good skills they sent.
    """
    two = {"skills": [a_submission()["skill"], a_submission()["skill"]]}

    with pytest.raises(Refused) as refusal:
        publisher.publish(on_the_wire(two))

    assert [screen.name for screen in refusal.value.screens] == ["one-skill"]
    assert "one skill" in refusal.value.screens[0].reason
    assert forges.proposals == []


def test_a_list_where_a_skill_belongs_is_the_same_refusal(publisher, forges):
    payload = a_submission()
    payload["skill"] = [payload["skill"]]

    with pytest.raises(Refused) as refusal:
        publisher.publish(on_the_wire(payload))

    assert [screen.name for screen in refusal.value.screens] == ["one-skill"]
    assert forges.proposals == []


def test_the_branch_is_the_skill_and_the_proposal_is_against_the_base(publisher, forges):
    """One skill names one branch, and the forge is asked for that one.

    `skill_commons.GitHubForge` cuts `skill/{name}` from `origin/{base}` every
    time, deliberately never from whatever the checkout was on. What this service
    contributes is the base it asks for, and it asks for one.
    """
    publisher.publish(on_the_wire(a_submission()))

    name, base, _ = forges.proposals[0]
    assert (name, base) == ("discord-read-latest-direct-message", "main")


def test_a_second_skill_is_a_second_submission_and_a_second_request(
    publisher, forges
):
    first = publisher.publish(on_the_wire(a_submission()))
    second = publisher.publish(
        on_the_wire(a_submission(a_route(task="open-a-server")))
    )

    assert (first.proposed, second.proposed) == (200, 201)
    assert [name for name, _, _ in forges.proposals] == [
        "discord-read-latest-direct-message",
        "discord-open-a-server",
    ]


def test_two_submissions_at_once_are_still_one_branch_each(forges, credentialled):
    """The rule survives concurrency, which is where it would otherwise die.

    `GitHubForge.propose` switches a branch, writes two files, commits and pushes,
    in a working copy this process shares with every request it is serving. Two of
    those interleaved is not slowness, it is a branch carrying somebody else's
    skill — the exact failure `forge.py` cuts from `origin/{base}` to avoid,
    reintroduced by a threaded server one level up. So the publish that touches
    the checkout is serialised, and this asserts it: the fake counts how many
    callers are inside `propose` at once, and the answer has to be one.
    """
    publisher = Publisher(forges, environ=credentialled)
    inside = []
    seen = []
    holding = threading.Barrier(2, timeout=5)

    class Watched:
        def __init__(self, submitter):
            self.real = forges.by_installation.setdefault(
                submitter, forges(submitter)
            )

        def open_requests(self):
            return self.real.open_requests()

        def propose(self, skill, *, base="main", credit=""):
            inside.append(1)
            seen.append(len(inside))
            try:
                # If two callers were ever in here together, the barrier lets
                # them both out and the count above already recorded a 2. It
                # times out — and fails the thread — precisely because they
                # cannot be, which is the property under test.
                try:
                    holding.wait(timeout=0.3)
                except threading.BrokenBarrierError:
                    pass
                return self.real.propose(skill, base=base, credit=credit)
            finally:
                inside.pop()

    publisher.forges = Watched

    def send(task):
        publisher.publish(on_the_wire(a_submission(a_route(task=task))))

    threads = [
        threading.Thread(target=send, args=(task,))
        for task in ("open-a-server", "join-a-voice-channel")
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)

    assert seen == [1, 1]
    assert len(forges.proposals) == 2
