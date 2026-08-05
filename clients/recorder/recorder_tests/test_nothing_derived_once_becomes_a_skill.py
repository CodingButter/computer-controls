"""What a skill may never contain, proved by looking in every git object.

`test_nothing_sensitive_is_committed.py` asks whether a secret reached the store
that recorded the work. This file asks the same question of the store that keeps
the *lessons*, and the answer has to be stronger for two reasons.

An episode is written from action results that already came through the
service's value-egress point, so the recorder inherits a guarantee. A skill is
written from what an agent read off the accessibility tree while it was working
— names, in clear, including the name of whoever it was messaging. There is no
egress point upstream of that. The protection is the design instead: a route
seen once is stored as salted digests and never as names, and a name is written
out only where a second, independent derivation produced the same digest.

The second reason is time. An episode is a record of one afternoon and reads as
one. A skill is advice, kept, consulted, and eventually copied — the artifact
most likely to be looked at a year later by somebody who was not there.

The searches are blunt on purpose. `--batch-all-objects` reaches loose objects,
packed objects, unreachable ones and objects on branches nobody merged, which is
more than any code path in this module knows how to produce. That is the point
of asking the object store rather than asking the program.
"""

from __future__ import annotations

import json

import pytest

from episode_recorder import Anchor, Author, Derivation, NotDurable, SkillLibrary
from recorder_tests.conftest import everything_ever_written

SECRET = "hunter2-correct-horse"
PERSON = "Alice Nichols"
MESSAGE = "meet me at six, the key is under the mat"

APPLICATION = "Discord"
TASK = "find a direct message by person"


def walk(library, *names, **fields):
    """One derivation whose deepest waypoints carry whatever it was reading."""
    return library.derive(
        Derivation(
            application=APPLICATION,
            task=TASK,
            anchors=(
                Anchor("frame", "Discord"),
                Anchor("list", "Direct Messages"),
                Anchor("list item", "", siblings=45),
                *(Anchor("link", name) for name in names),
            ),
            **fields,
        )
    )


def test_a_name_seen_once_reaches_no_object_in_the_store(library):
    """The candidate branch is the exposure, and it holds no names.

    A route has to be remembered before it can be agreed with, and remembering
    it is the moment a name would be written down. It is not: what is kept is
    the shape of the descent and one salted digest per name.
    """
    walk(library, PERSON, bound=())

    written = everything_ever_written(library.store)
    assert PERSON not in written
    assert "Alice" not in written
    assert "Nichols" not in written
    # And the record that was kept is still a record: the route is there.
    candidate = json.loads(
        library.store.git(
            "show", "candidates:candidates/discord/find-a-direct-message-by-person.json"
        )
    )
    assert [waypoint["role"] for waypoint in candidate["waypoints"]] == [
        "frame",
        "list",
        "list item",
        "link",
    ]
    assert all(len(waypoint["digest"]) == 16 for waypoint in candidate["waypoints"])


def test_a_name_two_walks_disagreed_about_reaches_no_object_either(library):
    walk(library, PERSON, bound=())
    outcome = walk(library, "Somebody Else", bound=())

    assert outcome.written, "the route agreed; only the name did not"
    written = everything_ever_written(library.store)
    assert PERSON not in written
    assert "Somebody Else" not in written
    # The landmarks both walks did produce are there, which is what makes this
    # a test about content rather than a test about an empty file.
    assert "Direct Messages" in written


def test_a_password_typed_where_a_name_goes_is_never_written(library):
    """The blunt instrument, aimed at the obvious mistake.

    Nothing should ever put a secret in an element name. The point of the test
    is that the store does not depend on that being true: a value that appears
    in one derivation and not the other is dropped by the same rule that drops
    a person's name, and nobody had to recognise it as a password.
    """
    walk(library, SECRET, bound=())
    walk(library, PERSON, bound=())

    written = everything_ever_written(library.store)
    assert SECRET not in written
    assert "hunter2" not in written


def test_what_the_run_was_looking_for_is_kept_out_even_when_it_repeats(library):
    walk(library, PERSON, bound=(PERSON,))
    outcome = walk(library, PERSON, bound=(PERSON,))

    assert outcome.written
    assert PERSON not in everything_ever_written(library.store)


def test_a_message_has_nowhere_to_be_written_down(library):
    """Not filtered. There is no field for what a thing said.

    A skill records where a value lives; the value itself is the one thing it
    is not for. An agent trying to keep the text it read has to put it in a
    place that does not exist — a role is a closed vocabulary, a task is a
    lower-case name, and a name is only kept when two walks agreed on it.
    """
    with pytest.raises(NotDurable):
        Anchor(MESSAGE, "el-message")

    with pytest.raises(NotDurable):
        Derivation(
            application=APPLICATION,
            task=MESSAGE,
            anchors=(Anchor("frame", "Discord"),),
            bound=(),
        )

    walk(library, MESSAGE, bound=())
    walk(library, PERSON, bound=())
    assert MESSAGE not in everything_ever_written(library.store)


def test_a_digest_is_no_use_to_anybody_who_does_not_have_the_store(tmp_path, agent):
    """The digest is salted, so it cannot be used to confirm a guess.

    Without a salt, a file of hashed display names is a lookup table: anybody
    who reads it can hash a list of likely names until one matches, and learn
    who the machine has been talking to. The salt is the store's own identity,
    written at the moment the store opened from the system's random source, and
    it never leaves the machine — so the same name recorded on two machines
    produces two unrelated digests.
    """
    def digest_of(path):
        library = SkillLibrary(path, Author(client_id="cl-1", label="hub"))
        walk(library, PERSON, bound=())
        candidate = json.loads(
            library.store.git(
                "show",
                "candidates:candidates/discord/find-a-direct-message-by-person.json",
            )
        )
        return candidate["waypoints"][-1]["digest"]

    assert digest_of(tmp_path / "here") != digest_of(tmp_path / "elsewhere")
