"""Fetching is opt-in, and opting back out costs nothing that was learned here.

"Revocable" is a promise about removal, and a promise about removal cannot be
kept if nothing on the machine can tell a route it downloaded from a route it
worked out. Both are two Markdown files in the same folder, deliberately — the
runtime reads them the same way and gives them the same standing — so the
difference has to be written down somewhere, and it is: `FETCHED.json`, beside
the pair, naming where and when.

Everything here follows from that one file. What came from the commons can be
listed, and taking it back does not touch anything that did not come from the
commons. The refusal is the load-bearing half: `remove` will not delete a folder
without a marker, so a mistyped name is an error rather than the loss of work
nobody else has a copy of.
"""

from __future__ import annotations

import pytest

from skill_commons import Fetcher, NotFetchable
from skill_commons.fetch import ORIGIN_FILE
from skill_commons.registry import SKILL_FILE, SkillRegistry, write_pair

from skill_commons_tests.conftest import a_route, another_route


@pytest.fixture
def mixed(here, published) -> Fetcher:
    """A commons holding one downloaded route and one this machine derived."""
    fetcher = Fetcher(here, published, today=lambda: "2026-08-07")
    fetcher.fetch("firefox-open-a-new-tab")
    write_pair(here, a_route())
    return fetcher


def test_what_came_from_the_commons_can_be_listed(mixed):
    fetched = mixed.fetched()

    assert [entry.name for entry in fetched] == ["firefox-open-a-new-tab"]
    assert fetched[0].source == "owner/repo@main"
    assert fetched[0].when == "2026-08-07"


def test_a_locally_derived_skill_is_not_in_that_list(mixed, here):
    """It is in the commons, and it is not the commons'.

    Same folder, same two files, no marker — which is the whole distinction,
    and the only one there is.
    """
    assert SkillRegistry(here).has("discord-read-latest-direct-message")
    assert "discord-read-latest-direct-message" not in [
        entry.name for entry in mixed.fetched()
    ]


def test_removing_a_fetched_skill_takes_it_and_nothing_else(mixed, here):
    mixed.remove("firefox-open-a-new-tab")

    assert not (here / "firefox-open-a-new-tab").exists()
    assert (here / "discord-read-latest-direct-message" / SKILL_FILE).is_file()
    assert SkillRegistry(here).has("discord-read-latest-direct-message")
    assert mixed.fetched() == ()


def test_removing_it_puts_it_back_on_the_list_of_things_to_fetch(mixed):
    """Revocable, not one-way. Changing your mind twice is allowed."""
    mixed.remove("firefox-open-a-new-tab")

    assert "firefox-open-a-new-tab" in mixed.available()

    again = mixed.fetch("firefox-open-a-new-tab")

    assert again.path.is_dir()


def test_what_this_machine_worked_out_is_not_the_commons_to_take_away(mixed, here):
    """The refusal that makes the promise safe to keep."""
    with pytest.raises(NotFetchable, match="did not come from the commons"):
        mixed.remove("discord-read-latest-direct-message")

    assert (here / "discord-read-latest-direct-message" / SKILL_FILE).is_file()


def test_a_fetch_that_would_land_on_local_work_is_refused(here, published):
    """The same rule at the other end of the trip.

    A machine that derived `firefox-open-a-new-tab` itself and then fetched the
    published one would have its own route overwritten by somebody else's, and
    would have no marker saying which one it now holds.
    """
    write_pair(here, another_route())
    fetcher = Fetcher(here, published)

    with pytest.raises(NotFetchable, match="already here and was not fetched"):
        fetcher.fetch("firefox-open-a-new-tab")

    assert not (here / "firefox-open-a-new-tab" / ORIGIN_FILE).exists()


def test_what_is_already_here_is_not_offered_again(here, published):
    write_pair(here, another_route())

    assert Fetcher(here, published).available() == (
        "discord-read-latest-direct-message",
    )


def test_a_half_written_fetch_is_still_removable(here, published, monkeypatch):
    """The marker goes down first, and this is what that buys.

    A fetch interrupted between the marker and the documents leaves a folder
    the registry will skip — which is fine, it is not a skill — but the person
    still has to be able to get rid of it. Marker last would have left a folder
    that could only be deleted by hand.
    """
    fetcher = Fetcher(here, published)
    monkeypatch.setattr("pathlib.Path.write_text", _breaks_after_the_marker())

    with pytest.raises(RuntimeError, match="the disk gave out"):
        fetcher.fetch("firefox-open-a-new-tab")

    monkeypatch.undo()

    assert not SkillRegistry(here).has("firefox-open-a-new-tab")
    assert [entry.name for entry in fetcher.fetched()] == ["firefox-open-a-new-tab"]

    fetcher.remove("firefox-open-a-new-tab")

    assert not (here / "firefox-open-a-new-tab").exists()


def _breaks_after_the_marker():
    import pathlib

    written = pathlib.Path.write_text

    def write(self, *args, **kwargs):
        if self.name != ORIGIN_FILE:
            raise RuntimeError("the disk gave out")
        return written(self, *args, **kwargs)

    return write
