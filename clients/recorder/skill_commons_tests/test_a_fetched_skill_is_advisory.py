"""A route that arrived from somewhere else is still only a route.

The commons folder is already an extension root — the runtime scans it and hands
what it finds to the agent as ordinary skills — so fetching does not need to
teach the runtime anything new. It needs to not quietly promote what it writes
there. A fetched skill has exactly the standing of one this machine derived:
advisory, carrying the version it was verified against, and checked step by step
against the tree in front of the agent following it. A landmark that is not there
is a skill to amend, not a step to retry.

Which is also why nothing is trusted for having been downloaded. The published
set is a public folder read without a credential, so what comes back is text
from the internet, and it goes through the same screens that let it be published
in the first place — a machine that believed text because it arrived over HTTPS
is a machine with a supply chain.
"""

from __future__ import annotations

import json

import pytest

from skill_commons import (
    ADVISORY,
    Fetcher,
    GitHubCommons,
    NotFetchable,
    render,
    render_review,
)
from skill_commons.registry import REVIEW_FILE, SKILL_FILE, SkillRegistry

from skill_commons_tests.conftest import (
    FakePublished,
    FakeTransport,
    a_route,
    another_route,
)


@pytest.fixture
def fetcher(here, published) -> Fetcher:
    return Fetcher(here, published, today=lambda: "2026-08-07")


def test_what_is_out_there_is_what_this_machine_does_not_have(fetcher):
    assert fetcher.available() == (
        "discord-read-latest-direct-message",
        "firefox-open-a-new-tab",
    )


def test_a_fetched_skill_lands_where_the_runtime_already_reads(fetcher, here):
    got = fetcher.fetch("discord-read-latest-direct-message")

    assert got.path == here / "discord-read-latest-direct-message"
    assert (got.path / SKILL_FILE).is_file()
    assert SkillRegistry(here).has("discord-read-latest-direct-message")


def test_a_fetched_skill_reads_back_as_the_route_that_was_published(fetcher, here):
    fetcher.fetch("discord-read-latest-direct-message")

    entry = SkillRegistry(here).get("discord-read-latest-direct-message")

    assert entry.app == "discord"
    assert entry.app_version_verified == "1.0.151"
    assert entry.verified_count == 3
    assert "Private channels" in entry.instructions
    assert "`setAttention`" in entry.instructions


def test_a_fetched_skill_says_out_loud_that_it_is_advisory(fetcher, here):
    """The sentence is on the file the agent reads, not in a note beside it."""
    fetcher.fetch("discord-read-latest-direct-message")

    document = (here / "discord-read-latest-direct-message" / SKILL_FILE).read_text()

    assert ADVISORY in document
    assert "Verify each step against the tree in front of you" in document


def test_a_fetched_skill_has_no_more_standing_than_a_local_one(
    fetcher, here, published
):
    """Same folder, same two files, same registry, no extra authority.

    The proof is that the registry cannot tell them apart: a locally-derived
    skill written into the same commons is listed beside the fetched one with
    the same shape of entry and nothing marking either as the one to believe.
    """
    fetcher.fetch("discord-read-latest-direct-message")
    fetcher.fetch("firefox-open-a-new-tab")

    listed = SkillRegistry(here).list()

    assert [entry.name for entry in listed] == [
        "discord-read-latest-direct-message",
        "firefox-open-a-new-tab",
    ]
    assert {type(entry) for entry in listed} == {type(listed[0])}
    assert all(ADVISORY in entry.instructions for entry in listed)


def test_the_review_comes_with_it(fetcher, here):
    """A fetched skill arrives with the reasoning that admitted it.

    Somebody deciding whether to keep a route should be able to read why the
    collective took it without leaving the machine, and the review is the file
    that says which landmarks were justified and how.
    """
    fetcher.fetch("discord-read-latest-direct-message")

    review = (here / "discord-read-latest-direct-message" / REVIEW_FILE).read_text()

    assert review == render_review(a_route())
    assert "Private channels" in review


def test_a_skill_that_lost_its_advisory_on_the_way_is_not_kept(here):
    """Refused rather than repaired.

    Adding the sentence back here would be this machine vouching for a file it
    did not write, and the thing it would be vouching for is the one property
    that stops a route being followed blind.
    """
    published = FakePublished(a_route())
    name = "discord-read-latest-direct-message"
    document, review = published.holds[name]
    published.holds[name] = (document.replace(ADVISORY, ""), review)

    with pytest.raises(NotFetchable, match="advisory"):
        Fetcher(here, published).fetch(name)

    assert not (here / name).exists()


def test_a_skill_carrying_something_a_published_skill_may_not_carry_is_refused(here):
    """The screens that ran where it was published run again where it lands."""
    published = FakePublished(a_route())
    name = "discord-read-latest-direct-message"
    document, review = published.holds[name]
    published.holds[name] = (
        document.replace("## The route", "## The route\n\nask alice@example.com\n"),
        review,
    )

    with pytest.raises(NotFetchable, match="an email address"):
        Fetcher(here, published).fetch(name)

    assert not (here / name).exists()


def test_a_skill_answering_to_another_name_is_refused(here):
    """A skill found under one name and loaded under another cannot be named.

    The registry already refuses this on read; refusing it on write means the
    folder never appears at all, rather than appearing and being skipped.
    """
    published = FakePublished(a_route())
    name = "discord-read-latest-direct-message"
    published.holds["firefox-open-a-new-tab"] = published.holds[name]

    with pytest.raises(NotFetchable, match="calls itself"):
        Fetcher(here, published).fetch("firefox-open-a-new-tab")


def test_a_name_that_is_not_a_name_never_becomes_a_path(here):
    """The listing is somebody else's text, and it is used to build a path.

    A name is held to the slug shape a skill's own name is held to, before it
    is joined onto the commons directory. `..` is not a slug.
    """
    published = FakePublished(a_route())
    published.holds["../../etc/skills"] = published.holds[
        "discord-read-latest-direct-message"
    ]

    with pytest.raises(NotFetchable, match="not a name"):
        Fetcher(here, published).fetch("../../etc/skills")

    assert "../../etc/skills" not in Fetcher(here, published).available()


def test_a_skill_with_a_header_this_package_would_not_write_is_refused(here):
    published = FakePublished(a_route())
    name = "discord-read-latest-direct-message"
    _, review = published.holds[name]
    published.holds[name] = ("no header at all\n" + ADVISORY, review)

    with pytest.raises(NotFetchable, match="header"):
        Fetcher(here, published).fetch(name)


def test_a_skill_arriving_without_its_review_is_refused(here):
    published = FakePublished(a_route())
    name = "discord-read-latest-direct-message"
    document, _ = published.holds[name]
    published.holds[name] = (document, "   \n")

    with pytest.raises(NotFetchable, match="without its review"):
        Fetcher(here, published).fetch(name)


def test_fetching_is_one_skill_at_a_time(fetcher, published):
    """There is no verb that takes the whole commons.

    Agreeing to a folder is not agreeing to a route, and the routes are what
    shape what an agent does next.
    """
    fetcher.fetch("discord-read-latest-direct-message")

    assert published.reads == ["discord-read-latest-direct-message"]
    assert fetcher.available() == ("firefox-open-a-new-tab",)


def test_where_a_fetched_skill_came_from_is_written_down(fetcher, here):
    fetcher.fetch("discord-read-latest-direct-message")

    marker = json.loads(
        (here / "discord-read-latest-direct-message" / "FETCHED.json").read_text()
    )

    assert marker["source"] == "owner/repo@main"
    assert marker["fetched"] == "2026-08-07"
    assert marker["skill"] == "discord-read-latest-direct-message"


def test_the_documents_are_the_ones_that_were_published(fetcher, here):
    """Byte for byte. A fetch that rewrote what it stored would be a fork."""
    fetcher.fetch("firefox-open-a-new-tab")

    folder = here / "firefox-open-a-new-tab"

    assert (folder / SKILL_FILE).read_text() == render(another_route())
    assert (folder / REVIEW_FILE).read_text() == render_review(another_route())


def test_the_published_set_is_read_the_way_anybody_without_an_account_reads_it(
    here,
):
    """Two plain GETs at a public repository, and no credential on either.

    A commons only readable by somebody with an account is not published, so
    the read side sends no token for the same reason the write side holds
    none — and this checks the requests rather than the outcome, because the
    outcome looks identical right up until the day it needs a login.
    """
    transport = FakeTransport(
        answers={
            "api.github.com": json.dumps(
                [
                    {"name": "discord-read-latest-direct-message", "type": "dir"},
                    {"name": "README.md", "type": "file"},
                ]
            ),
            "SKILL.md": render(a_route()),
            "REVIEW.md": render_review(a_route()),
        }
    )
    commons = GitHubCommons("owner/repo", transport=transport)

    fetched = Fetcher(here, commons).fetch(commons.names()[0])

    assert commons.names() == ("discord-read-latest-direct-message",)
    assert fetched.source == "owner/repo@main"
    assert (fetched.path / SKILL_FILE).read_text() == render(a_route())
    for request in transport.requests:
        assert "authorization" not in {key.lower() for key in request.headers}
        assert request.data is None


def test_a_published_set_that_is_not_there_says_so(here):
    transport = FakeTransport(status=404, body="Not Found")

    with pytest.raises(NotFetchable, match="404"):
        GitHubCommons("owner/repo", transport=transport).names()
