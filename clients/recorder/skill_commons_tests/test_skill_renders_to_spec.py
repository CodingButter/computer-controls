"""The published pair, held to the format the runtime will read it in.

A skill that is correct and unreadable is a skill nobody loads. The Agent Skills
specification the agent runtime implements wants a fenced header with a name and
a description at the top of `SKILL.md`, and it wants the body below the header to
be the instructions and nothing else — so that a header can never end up in the
text an agent is handed as though somebody wrote it there on purpose.

Both halves of that are asserted here, and so is the round trip: what this
package writes, this package reads back to the same skill. A registry whose
writer and reader disagreed would be a registry that worked until somebody
restarted it.
"""

from __future__ import annotations

import pytest

from episode_recorder import Author

from skill_commons import (
    Amendment,
    MalformedHeader,
    Skill,
    Step,
    Verification,
    frontmatter,
    header,
    render,
    render_review,
)

SKILL = Skill(
    app="discord",
    task="read-latest-direct-message",
    steps=(
        Step(ordinal=1, method="census"),
        Step(ordinal=2, method="setAttention", role="window"),
        Step(ordinal=3, method="describeElement", role="list",
             landmark="Private channels"),
        Step(ordinal=4, method="describeElement", role="list item"),
    ),
    verification=Verification(app_version="1.0.151", when="2026-08-05", successes=3),
    author=Author(client_id="client-7", label="hub"),
)


# -- the header -----------------------------------------------------------


def test_the_file_opens_with_a_header_the_runtime_can_read():
    fields, instructions = frontmatter.parse(render(SKILL))
    assert fields["name"] == "discord-read-latest-direct-message"
    assert fields["description"]
    assert instructions.startswith("# discord: read latest direct message")


def test_the_name_is_a_slug_the_specification_would_accept():
    name = header(SKILL)["name"]
    assert name == name.lower()
    assert 1 <= len(name) <= 64
    assert all(character.isalnum() or character == "-" for character in name)


def test_the_description_fits_and_says_what_the_task_is():
    description = header(SKILL)["description"]
    assert 1 <= len(description) <= 1024
    assert "direct message" in description
    assert "discord" in description


def test_the_staleness_signal_is_in_the_header_not_only_the_prose():
    """A reader deciding whether to trust this should not have to read it."""
    metadata = header(SKILL)["metadata"]
    assert metadata["app-version-verified"] == "1.0.151"
    assert metadata["last-verified"] == "2026-08-05"
    assert metadata["verified-count"] == 3


def test_the_header_is_not_in_the_instructions():
    _, instructions = frontmatter.parse(render(SKILL))
    assert "app-version-verified" not in instructions
    assert "---" not in instructions.splitlines()[:1]


def test_a_header_holds_one_fact_per_line():
    """The reason this package does not reach for a general parser.

    A value that could contain a newline could contain a second header, and a
    second header is a place to hide a fact from whoever read the first one.
    """
    with pytest.raises(MalformedHeader):
        frontmatter.dump({"description": "one line\nand another"})


def test_a_file_with_no_header_is_not_a_skill_with_an_empty_one():
    with pytest.raises(MalformedHeader):
        frontmatter.parse("# just some markdown\n")


def test_a_header_that_is_never_closed_is_refused():
    with pytest.raises(MalformedHeader):
        frontmatter.parse("---\nname: something\n\n# body\n")


def test_the_header_round_trips():
    fields = header(SKILL)
    read_back, _ = frontmatter.parse(frontmatter.dump(fields) + "\nbody\n")
    assert read_back == fields


def test_a_date_survives_being_read_by_something_that_is_not_this_package():
    """The half of the round trip this package does not control.

    These files are written here and read by a YAML parser in another language,
    and YAML types a bare scalar by looking at it: `2026-08-05` is a date to one
    reader and a string to another, and `1.0` is a version to a person and a
    float to both. The round-trip test above cannot see any of that, because a
    parser that agrees with the writer about everything agrees about this too.

    So every string is written quoted, which is the one form no reader is
    entitled to reinterpret. The assertion is on the bytes rather than on the
    parse, because the bytes are what the other reader gets.
    """
    text = frontmatter.dump(header(SKILL))
    assert '"2026-08-05"' in text
    assert '"1.0.151"' in text
    assert "last-verified: 2026-08-05" not in text
    # A count is the exception, and deliberately: it is the only field this
    # package means as a number, so it is the only one a reader may infer.
    assert "verified-count: 3" in text


def test_an_unquoted_string_is_not_a_header_this_package_wrote():
    """Refused on the way in, not repaired.

    A header with bare scalars was written by something else — an editor, a
    generator, a person — and this package has no way to know what that
    something meant by them. Reading it as a string would be guessing, and
    guessing is exactly the failure the quoting closes.
    """
    with pytest.raises(MalformedHeader):
        frontmatter.parse('---\nname: some-skill\n---\n\nbody\n')


def test_a_value_that_would_have_to_be_escaped_is_refused_instead():
    with pytest.raises(MalformedHeader):
        frontmatter.dump({"description": 'a "quoted" thing'})
    with pytest.raises(MalformedHeader):
        frontmatter.dump({"description": "a back\\slash"})


# -- the body -------------------------------------------------------------


def test_every_step_appears_in_the_route():
    text = render(SKILL)
    for step in SKILL.steps:
        assert f"| {step.ordinal} | `{step.method}` |" in text


def test_the_route_says_it_is_advisory():
    assert "advisory" in render(SKILL).lower()
    assert "Verify each step against the tree in front of you" in render(SKILL)


def test_an_unamended_skill_says_so_rather_than_leaving_a_gap():
    assert "This is the route as it was first derived." in render(SKILL)


def test_an_amendment_is_published_with_what_it_was_checked_against():
    amended = SKILL.amended(
        Amendment(
            kind="landmark-moved",
            step=3,
            app_version="1.0.160",
            when="2026-09-01",
        ),
        steps=SKILL.steps,
        verification=Verification(
            app_version="1.0.160", when="2026-09-01", successes=4
        ),
    )
    text = render(amended)
    assert "the same element, found under a different landmark" in text
    assert "1.0.160" in text
    # The history is appended, never replaced: a skill whose past can be
    # rewritten is a skill whose past is a summary.
    assert len(amended.amendments) == 1
    assert SKILL.amendments == ()


# -- the review, which is the other half of a submission ------------------


def test_the_review_names_every_landmark_in_the_route():
    review = render_review(SKILL)
    for landmark in SKILL.landmarks:
        assert landmark in review


def test_the_review_cannot_miss_a_landmark_because_both_files_share_a_source():
    """The property that makes 'every step was justified' checkable.

    Both files are generated from the same tuple of steps, so a route with a
    landmark the review does not mention is not a thing that can be submitted.
    """
    crowded = Skill(
        app="discord",
        task="send-a-direct-message",
        steps=(
            Step(ordinal=1, method="census"),
            Step(ordinal=2, method="describeElement", landmark="Private channels"),
            Step(ordinal=3, method="describeElement", landmark="Message box"),
            Step(ordinal=4, method="invokeAction", landmark="Send"),
        ),
        verification=Verification(app_version="1.0.151", when="2026-08-05", successes=2),
        author=Author(client_id="client-7", label="hub"),
    )
    review = render_review(crowded)
    assert set(crowded.landmarks) == {"Private channels", "Message box", "Send"}
    for landmark in crowded.landmarks:
        assert f"| `{landmark}` |" in review


def test_the_review_says_what_the_screens_could_not_answer():
    review = render_review(SKILL)
    assert "What the screens could not answer" in review
    assert "cannot tell a piece of chrome from somebody's name" in review


def test_the_review_states_that_nothing_published_here_executes():
    assert "no scripts and no binaries" in render_review(SKILL)
