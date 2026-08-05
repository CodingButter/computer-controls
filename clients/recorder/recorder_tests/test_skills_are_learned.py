"""A route becomes a procedure, and stays one when the application moves.

The case these tests are written from is a real one. An agent was asked what
somebody had said in a direct message, read the list of conversations, found
forty-five rows with no names on them, and answered that no such conversation
existed — while the conversation sat first in the list. The names were three
levels down, under each row's link, written in mathematical-bold codepoints
that an exact match misses. Every session before and since re-derived that same
tree from nothing.

So the thing being tested is not "can a route be stored". It is whether the
route that *would* have prevented that answer can be learned by the agent that
worked it out, kept in a shape the next session can start from, and amended
rather than believed when Discord moves the furniture.
"""

from __future__ import annotations

import json

import pytest

from episode_recorder import Anchor, Derivation, NotDurable, Stumble

#: The display name as Discord actually renders it: mathematical bold, which is
#: a different string from the letters it looks like.
STYLIZED = "\U0001d41c\U0001d428\U0001d428\U0001d424\U0001d422\U0001d41e"

APPLICATION = "Discord"
TASK = "find a direct message by person"


def dm(person: str, *, version: str = "1.0.151", crowd: int = 45, stumbles=()):
    """One agent's walk to one person's direct message.

    The shape of the descent is the finding: `Private channels` holds a list of
    rows, the rows have no names of their own, and the name is on a link inside
    each one.
    """
    return Derivation(
        application=APPLICATION,
        task=TASK,
        version=version,
        anchors=(
            Anchor("frame", "Discord"),
            Anchor("list", "Direct Messages", siblings=3),
            Anchor("list item", "", siblings=crowd),
            Anchor("link", person),
        ),
        stumbles=tuple(stumbles),
        bound=(person,),
    )


def learned(library, first=STYLIZED, second="Tyler Barnes"):
    """A skill, by the only route to one: derived twice and agreed."""
    library.derive(dm(first))
    return library.derive(dm(second))


# -- the bar ------------------------------------------------------------


def test_a_route_walked_once_is_not_yet_a_skill(library):
    outcome = library.derive(dm(STYLIZED))

    assert outcome.status == "candidate"
    assert not outcome.written
    assert library.find(APPLICATION, TASK) is None
    assert library.skills() == []


def test_a_route_walked_twice_is_a_skill(library):
    outcome = learned(library)

    assert outcome.status == "written"
    assert outcome.written
    skill = library.find(APPLICATION, TASK)
    assert skill is not None
    assert [waypoint.role for waypoint in skill.waypoints] == [
        "frame",
        "list",
        "list item",
        "link",
    ]
    assert skill.derivations == 2
    assert skill.standing


def test_the_library_is_a_directory_of_skill_files(library):
    learned(library)

    written = library.store.path / "discord" / "find-a-direct-message-by-person"
    text = (written / "SKILL.md").read_text()
    assert text.startswith("---\n")
    assert "name: discord-find-a-direct-message-by-person" in text
    assert "description: Where to go in Discord to find a direct message by person." in text
    # The working tree is the library. A caller that wandered onto the branch
    # where candidates live and stayed there would have emptied this directory.
    assert library.store.current_branch() == "main"


# -- what agreement keeps, and what it refuses to keep -------------------


def test_the_landmark_both_walks_saw_is_written_in_clear(library):
    skill = learned(library).skill

    assert skill.waypoints[0].name == "Discord"
    assert skill.waypoints[1].name == "Direct Messages"


def test_what_the_two_walks_disagreed_about_becomes_a_hole(library):
    skill = learned(library).skill

    person = skill.waypoints[3]
    assert person.name == ""
    assert person.varies
    assert "whose name is the thing being looked for" in skill.render()
    assert "Tyler" not in skill.render()


def test_a_name_the_task_was_looking_for_is_holed_even_when_both_walks_agree(library):
    """The lock agreement cannot provide on its own.

    Two runs that happened to look for the same person agree about that
    person's name, and agreement alone would write it down. It is still not a
    property of Discord — it is what the agent was doing — so the value the run
    was bound to is holed regardless of how many times it recurred.
    """
    library.derive(dm("Tyler Barnes"))
    skill = library.derive(dm("Tyler Barnes")).skill

    assert skill.waypoints[3].name == ""
    assert skill.waypoints[3].varies
    assert "Tyler" not in skill.render()


def test_a_bound_value_that_survives_anywhere_refuses_the_write(library):
    """Refused, not scrubbed.

    The check is deliberately blunt and deliberately last: it looks at the
    finished document rather than at the fields, so it catches a value that
    arrived by a route nobody anticipated. A library that quietly deleted the
    offending word would hand back a skill with a hole in a sentence and tell
    nobody.
    """
    def bad(person):
        return Derivation(
            application="Cookie",
            task="find a direct message",
            anchors=(Anchor("frame", "Cookie"), Anchor("link", person)),
            bound=("cookie",),
        )

    library.derive(bad("one"))
    with pytest.raises(NotDurable):
        library.derive(bad("two"))


def test_two_different_routes_are_not_merged_into_a_third(library):
    """A route neither agent walked would be the worst possible answer."""
    library.derive(dm(STYLIZED))

    moved = Derivation(
        application=APPLICATION,
        task=TASK,
        anchors=(Anchor("frame", "Discord"), Anchor("tree item", "someone")),
        bound=("someone",),
    )
    assert library.derive(moved).status == "candidate"
    assert library.find(APPLICATION, TASK) is None

    # The second route, walked again, is a skill on its own terms.
    outcome = library.derive(moved)
    assert outcome.status == "written"
    assert [waypoint.role for waypoint in outcome.skill.waypoints] == [
        "frame",
        "tree item",
    ]


# -- what the route teaches ---------------------------------------------


def test_the_warnings_are_read_out_of_the_route(library):
    """No field for advice, and advice anyway.

    Each of these is a consequence of the agreed route rather than something an
    agent was allowed to type, which is why a skill cannot warn about something
    two walks did not both see.
    """
    notes = " ".join(learned(library).skill.notes())

    assert "carries no name of its own" in notes
    assert "on the **link**" in notes
    assert "NFKC" in notes
    assert "45 items" in notes


def test_a_stumble_both_walks_hit_is_kept_and_one_walk_is_weather(library):
    twice = (Stumble("describeElement", "ELEMENT_STALE"),)
    once = (Stumble("describeElement", "ELEMENT_STALE"), Stumble("focus", "TIMEOUT"))

    library.derive(dm(STYLIZED, stumbles=once))
    skill = library.derive(dm("Tyler Barnes", stumbles=twice)).skill

    assert [(s.method, s.error) for s in skill.stumbles] == [
        ("describeElement", "ELEMENT_STALE")
    ]
    assert "ELEMENT_STALE" in " ".join(skill.notes())
    assert "TIMEOUT" not in " ".join(skill.notes())


# -- staleness ----------------------------------------------------------


def moved_route(*, version="1.1.0"):
    """Discord after somebody rebuilt the sidebar as a tree."""
    return Derivation(
        application=APPLICATION,
        task=TASK,
        version=version,
        anchors=(
            Anchor("frame", "Discord"),
            Anchor("tree", "Direct Messages", siblings=3),
            Anchor("tree item", "", siblings=60),
            Anchor("link", "somebody"),
        ),
        bound=("somebody",),
    )


def test_a_route_that_still_holds_is_verified_rather_than_rewritten(library):
    learned(library)
    outcome = library.derive(dm("Someone Else", version="1.0.160"))

    assert outcome.status == "verified"
    assert outcome.skill.derivations == 3
    assert outcome.skill.version == "1.0.160"
    assert outcome.skill.standing
    assert "derived the same way 3 times" in outcome.skill.render()


def test_a_route_that_no_longer_holds_says_so_before_it_knows_the_way(library):
    """The warning lands on the first failure, the replacement does not.

    A map that is wrong is dangerous the moment it is wrong, and an agent
    reading this between the breakage and the amendment has to be told. But one
    sighting of a new route is still one sighting, so the old route stays on
    the page — marked — rather than being replaced by a guess.
    """
    learned(library)
    outcome = library.derive(moved_route())

    assert outcome.status == "shaken"
    assert not outcome.skill.standing
    assert "did not hold" in outcome.skill.render().lower()
    assert [waypoint.role for waypoint in library.find(APPLICATION, TASK).waypoints] == [
        "frame",
        "list",
        "list item",
        "link",
    ]


def test_a_stale_route_is_amended_and_the_amendment_says_what_moved(library):
    learned(library)
    library.derive(moved_route())
    outcome = library.derive(moved_route(version="1.1.1"))

    assert outcome.status == "amended"
    skill = library.find(APPLICATION, TASK)
    assert skill.standing
    assert skill.version == "1.1.1"
    assert [waypoint.role for waypoint in skill.waypoints] == [
        "frame",
        "tree",
        "tree item",
        "link",
    ]
    changed = " ".join(skill.changes)
    assert "Step 2 was a list and is now a tree" in changed
    assert "Step 3 was a list item and is now a tree item" in changed
    assert "What changed at the last amendment" in skill.render()


def test_a_route_that_comes_back_retires_the_amendment_waiting_on_it(library):
    """The application contradicting the evidence is the end of the evidence."""
    learned(library)
    library.derive(moved_route())
    assert library.derive(dm("Someone Else")).status == "verified"

    # With the candidate spent, one sighting of the other route is one sighting
    # again — it shakes the skill rather than replacing it.
    assert library.derive(moved_route()).status == "shaken"
    assert [w.role for w in library.find(APPLICATION, TASK).waypoints][1] == "list"


def test_an_amendment_records_the_history_as_commits(library):
    learned(library)
    library.derive(moved_route())
    library.derive(moved_route())

    subjects = library.store.git(
        "log", "--format=%s", "main", "--", "discord/find-a-direct-message-by-person"
    ).splitlines()
    assert subjects[0].endswith(": amended")
    assert any(line.endswith(": did not hold") for line in subjects)
    assert subjects[-1].endswith(": learned")
    # And when it happened is git's answer, not the file's.
    assert library.verified_at(library.find(APPLICATION, TASK))


# -- what cannot be said at all -----------------------------------------


def test_an_element_can_only_be_anchored_by_a_role_the_layer_uses(library):
    with pytest.raises(NotDurable):
        Anchor("the box on the left", "Discord")


def test_a_task_is_a_name_and_not_a_sentence(library):
    with pytest.raises(NotDurable):
        Derivation(
            application=APPLICATION,
            task="read what Alice said about the price: 'meet me at six'",
            anchors=(Anchor("frame", "Discord"),),
            bound=(),
        )


def test_a_derivation_cannot_be_made_without_saying_what_it_was_looking_for(library):
    """A field with a safe default is a field nobody fills in."""
    with pytest.raises(TypeError):
        Derivation(
            application=APPLICATION,
            task=TASK,
            anchors=(Anchor("frame", "Discord"),),
        )


def test_a_route_has_nowhere_to_put_an_element_id(library):
    """Not filtered — absent. A handle dies with the session that issued it."""
    with pytest.raises(TypeError):
        Anchor("link", "Discord", element_id="el-4131")

    skill = learned(library).skill
    written = json.dumps(skill.document)
    assert "element" not in written.lower()
    assert "el-" not in skill.render()
