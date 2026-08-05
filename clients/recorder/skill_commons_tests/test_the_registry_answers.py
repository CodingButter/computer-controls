"""What an agent can ask the commons, and what it is told when the answer is no.

The interesting assertions here are not that a list has two things in it. They
are the ones about failure: a folder that cannot be read is skipped rather than
taking the registry down with it, *and* it is reported by name rather than
vanishing — because a skill a contributor thinks they published and an agent
cannot find is exactly the discrepancy a silent skip creates.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from skill_commons.registry import SkillRegistry, write_pair

from skill_commons_tests.conftest import a_route, another_route


# -- listing and fetching -------------------------------------------------


def test_the_directory_is_the_index(registry: SkillRegistry):
    assert [entry.name for entry in registry.list()] == [
        "discord-read-latest-direct-message",
        "firefox-open-a-new-tab",
    ]


def test_a_skill_is_fetched_by_the_name_it_is_filed_under(registry: SkillRegistry):
    entry = registry.get("discord-read-latest-direct-message")
    assert entry is not None
    assert entry.app == "discord"
    assert entry.task == "read-latest-direct-message"
    assert "Private channels" in entry.instructions


def test_a_skill_that_is_not_there_is_answered_rather_than_raised(registry):
    assert registry.get("discord-delete-everything") is None
    assert not registry.has("discord-delete-everything")


def test_the_staleness_signal_survives_the_round_trip(registry: SkillRegistry):
    """The whole reason a consumer can weight one route above another."""
    entry = registry.get("discord-read-latest-direct-message")
    assert entry.app_version_verified == "1.0.151"
    assert entry.last_verified == "2026-08-05"
    assert entry.verified_count == 3


def test_skills_can_be_asked_for_by_application(registry: SkillRegistry):
    assert [entry.name for entry in registry.for_app("firefox")] == [
        "firefox-open-a-new-tab"
    ]
    assert registry.for_app("slack") == ()


def test_an_empty_commons_is_a_registry_with_nothing_in_it(tmp_path: Path):
    assert SkillRegistry(tmp_path / "nothing-here").list() == ()


# -- searching ------------------------------------------------------------


def test_a_task_described_in_other_words_still_finds_the_route(registry):
    hits = registry.search("read a discord message")
    assert hits
    assert hits[0].entry.name == "discord-read-latest-direct-message"


def test_the_skill_the_query_is_about_outranks_the_one_that_mentions_it(commons):
    """Word overlap alone would tie; where the word matched breaks it.

    A route that walks *past* a tab bar on its way somewhere else mentions the
    word as often as the route that opens a tab. Ranking them the same is how a
    search returns the skill that is nearly right.
    """
    from skill_commons import Step

    write_pair(
        commons,
        another_route(
            app="firefox",
            task="read-the-address-bar",
            steps=(
                Step(ordinal=1, method="census"),
                Step(ordinal=2, method="describeElement", role="page tab",
                     landmark="Tab bar"),
                Step(ordinal=3, method="describeElement", role="entry",
                     landmark="Address bar"),
            ),
        ),
    )
    hits = SkillRegistry(commons).search("tab")
    names = [hit.entry.name for hit in hits]
    assert names[0] == "firefox-open-a-new-tab"
    assert "firefox-read-the-address-bar" in names


def test_a_query_of_nothing_but_noise_matches_nothing(registry):
    assert registry.search("the and of it") == ()


def test_a_query_matching_nothing_answers_with_nothing(registry):
    assert registry.search("spreadsheet pivot table") == ()


# -- what happens when a folder is wrong ----------------------------------


def test_a_folder_that_is_not_a_skill_is_not_a_skill_that_failed(commons: Path):
    (commons / "notes").mkdir()
    (commons / "notes" / "README.md").write_text("# scratch\n")
    registry = SkillRegistry(commons)
    assert len(registry.list()) == 2
    assert registry.unreadable() == ()


def test_one_malformed_skill_does_not_take_the_registry_offline(commons: Path):
    broken = commons / "slack-do-something"
    broken.mkdir()
    (broken / "SKILL.md").write_text("no header here, just prose\n")

    registry = SkillRegistry(commons)
    assert len(registry.list()) == 2

    (refused,) = registry.unreadable()
    assert refused.path == broken
    assert "header" in refused.reason


def test_a_skill_loaded_under_a_name_it_does_not_claim_is_refused(commons: Path):
    """A skill found under one name and loaded under another cannot be named.

    An agent told it is using `firefox-open-a-new-tab` while following a route
    that calls itself something else has been handed a route it did not ask
    for, and that is the shape a poisoned submission takes.
    """
    impostor = commons / "firefox-print-the-page"
    impostor.mkdir()
    (impostor / "SKILL.md").write_text(
        (commons / "discord-read-latest-direct-message" / "SKILL.md").read_text()
    )

    registry = SkillRegistry(commons)
    assert not registry.has("firefox-print-the-page")
    (refused,) = registry.unreadable()
    assert refused.path == impostor
    assert "calls itself" in refused.reason


def test_a_skill_with_no_metadata_block_is_refused(commons: Path):
    naked = commons / "slack-read-a-message"
    naked.mkdir()
    (naked / "SKILL.md").write_text(
        '---\nname: "slack-read-a-message"\ndescription: "something"\n---\n\n# body\n'
    )
    registry = SkillRegistry(commons)
    assert not registry.has("slack-read-a-message")
    assert "metadata" in registry.unreadable()[0].reason


# -- reading answers the same thing twice ---------------------------------


def test_the_registry_does_not_change_its_answer_mid_turn(commons: Path):
    """A question asked twice in one turn has one answer.

    Re-reading the disk on every call would let an agent reason about a set of
    skills that changed underneath it between two lines of the same plan.
    """
    registry = SkillRegistry(commons)
    write_pair(commons, another_route(app="slack", task="read-a-message"))

    assert len(registry.list()) == 2
    registry.refresh()
    assert len(registry.list()) == 3


# -- both halves, always --------------------------------------------------


def test_writing_a_skill_writes_the_review_beside_it(tmp_path: Path):
    """A commit carrying a skill with no review is a submission with no case."""
    document, review = write_pair(tmp_path, a_route())
    assert document.name == "SKILL.md"
    assert review.name == "REVIEW.md"
    assert document.parent == review.parent
    assert "reviewer decides" in review.read_text()
