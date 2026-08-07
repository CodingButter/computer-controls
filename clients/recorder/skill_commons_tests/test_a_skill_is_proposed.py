"""What the machine says to the forge, proved without one.

The recorder's board suite makes the same bargain and states it plainly: what
cannot be proved here is that GitHub accepts the command; what can be proved,
and is, is that the command says what we meant. The failures that argument is
aimed at are real ones — a branch cut from whatever was checked out, a base that
is not the default, a push with no upstream, a pull request whose head nobody
set — and every one of them produces a proposal that looks fine until somebody
opens it.

The assertion this file exists for is the last one: there is no method on the
forge that merges. A proposal is the most an agent can do.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from skill_commons import Opinion, Review, Skill
from skill_commons.forge import BRANCH_PREFIX, ForgeError, GitHubForge

from skill_commons_tests.conftest import a_route, another_route

#: What a reader answered. Every proposal carries one — the forge will not cut a
#: branch without it, which `test_nothing_publishes_without_a_review.py` is the
#: file for. Here it is a fixed pass so that these tests stay about the argument
#: lists they were written for.
READ = Review((Opinion(reviewer="reader-a", passed=True),))


@pytest.fixture
def forge_at(tmp_path: Path, forge):
    def build(**changed) -> GitHubForge:
        checkout = tmp_path / "checkout"
        checkout.mkdir(exist_ok=True)
        fields = dict(
            repo="owner/repo",
            checkout=checkout,
            submitter="installation-3f9a",
            run=forge,
        )
        fields.update(changed)
        return GitHubForge(**fields)

    return build


# -- the branch ------------------------------------------------------------


def test_the_branch_is_cut_from_the_base_and_not_from_whatever_was_here(
    forge_at, forge
):
    """A proposal branched off another proposal carries its skill along.

    A reviewer approving two skills while reading one is precisely the failure
    the pair and the review exist to prevent, and it arrives by accident rather
    than by malice — which is why the base is fetched and named every time.
    """
    forge_at().propose(a_route(), read_by=READ, base="main")

    fetch = [call for call in forge.calls if "fetch" in call][0]
    assert fetch[3:] == ("fetch", "origin", "main")
    switch = [call for call in forge.calls if "switch" in call][0]
    assert switch[-3:] == (
        "--force-create",
        f"{BRANCH_PREFIX}discord-read-latest-direct-message",
        "origin/main",
    )


def test_the_push_sets_an_upstream_and_does_not_clobber_a_stranger(forge_at, forge):
    forge_at().propose(a_route(), read_by=READ)
    push = [call for call in forge.calls if "push" in call][0]
    assert "--force-with-lease" in push
    assert "--set-upstream" in push
    assert push[-2:] == ("origin", f"{BRANCH_PREFIX}discord-read-latest-direct-message")


def test_only_the_one_skills_folder_is_staged(forge_at, forge):
    """A proposal that staged the working tree would carry whatever was in it."""
    forge_at().propose(a_route(), read_by=READ)
    add = [call for call in forge.calls if "add" in call][0]
    assert add[-1] == "skills/discord-read-latest-direct-message"


def test_the_commit_message_is_assembled_rather_than_written(forge_at, forge):
    forge_at().propose(a_route(), read_by=READ)
    commit = [call for call in forge.calls if "commit" in call][0]
    message = commit[commit.index("--message") + 1]
    assert message.startswith("skill(discord): read latest direct message")
    assert "Skill-Signature:" in message


# -- the pull request ------------------------------------------------------


def test_the_request_names_its_base_and_its_head(forge_at, forge):
    forge_at().propose(a_route(), read_by=READ, base="main")
    create = forge.argv_for("gh", "pr", "create")
    assert create[create.index("--base") + 1] == "main"
    assert create[create.index("--head") + 1] == (
        f"{BRANCH_PREFIX}discord-read-latest-direct-message"
    )
    assert create[create.index("--repo") + 1] == "owner/repo"


def test_the_number_comes_back_from_the_url_the_forge_printed(forge_at):
    assert forge_at().propose(a_route(), read_by=READ) == 200


def test_a_forge_that_answers_with_no_number_is_an_error(forge_at, forge):
    forge.__class__ = type(
        "Terse", (), {"__call__": lambda self, argv: (0, "created\n", "")}
    )
    with pytest.raises(ForgeError):
        forge_at().propose(a_route(), read_by=READ)


def test_a_command_that_fails_carries_what_the_forge_said(forge_at, forge):
    forge.fail_with = "remote: permission denied"
    with pytest.raises(ForgeError) as refused:
        forge_at().propose(a_route(), read_by=READ)
    assert "permission denied" in str(refused.value)


# -- what the reviewer is told ---------------------------------------------


def test_the_body_points_at_both_halves_of_the_pair(forge_at, forge):
    forge_at().propose(a_route(), read_by=READ)
    body = _body(forge)
    assert "skills/discord-read-latest-direct-message/SKILL.md" in body
    assert "skills/discord-read-latest-direct-message/REVIEW.md" in body


def test_the_body_says_what_the_reviewer_is_being_asked_to_decide(forge_at, forge):
    forge_at().propose(a_route(), read_by=READ)
    body = _body(forge)
    assert "What is being asked of you" in body
    assert "no pattern can tell those apart" in body


def test_the_body_is_not_a_summary_of_the_route(forge_at, forge):
    """A persuasive summary is a reviewer prepared to approve.

    The route is in the files. What the request body carries is what the
    submission *is* — never the landmarks, never the steps, never an argument
    for them.
    """
    forge_at().propose(a_route(), read_by=READ)
    body = _body(forge)
    assert "Private channels" not in body
    assert "describeElement" not in body


def test_the_body_carries_a_trailer_that_says_which_machine(forge_at, forge):
    forge_at().propose(a_route(), read_by=READ)
    assert "proposed-by installation-3f9a" in _body(forge)


# -- one machine's proposals are its own -----------------------------------


def test_open_requests_are_matched_by_trailer_and_not_by_author(forge_at, forge):
    """Every machine files through one account, so the author says nothing."""
    forge_at().open_requests()
    listed = forge.argv_for("gh", "pr", "list")
    assert '"proposed-by installation-3f9a" in:body' in listed
    assert "--author" not in listed


def test_two_machines_do_not_see_each_others_proposals(forge_at, forge):
    forge_at().propose(a_route(), read_by=READ)
    forge_at(submitter="installation-77b1").propose(another_route(), read_by=READ)

    bodies = [
        call[call.index("--body") + 1]
        for call in forge.calls
        if call[1:3] == ("pr", "create")
    ]
    assert "proposed-by installation-3f9a" in bodies[0]
    assert "proposed-by installation-77b1" in bodies[1]
    assert "installation-77b1" not in bodies[0]


def test_withdrawing_says_why_and_takes_the_branch_with_it(forge_at, forge):
    number = forge_at().propose(a_route(), read_by=READ)
    forge_at().withdraw(number, "superseded by a route verified against 1.0.160")

    close = forge.argv_for("gh", "pr", "close")
    assert close[3] == str(number)
    assert "--delete-branch" in close
    assert "superseded" in close[close.index("--comment") + 1]


# -- what a forge cannot do ------------------------------------------------


def test_nothing_here_can_admit_a_skill():
    """The absence that makes this a proposal rather than a publication.

    An agent may ask that a skill be admitted. Admitting it is a person reading
    two files, and a forge with a merge on it is a forge somebody eventually
    has merge.
    """
    surface = {
        name
        for name in dir(GitHubForge)
        if not name.startswith("_") and callable(getattr(GitHubForge, name))
    }
    assert surface == {"open_requests", "propose", "withdraw"}


def test_the_files_are_written_where_the_request_says_they_are(forge_at, tmp_path):
    forge_at().propose(a_route(), read_by=READ)
    folder = tmp_path / "checkout" / "skills" / "discord-read-latest-direct-message"
    assert (folder / "SKILL.md").is_file()
    assert (folder / "REVIEW.md").is_file()


def _body(forge) -> str:
    create = forge.argv_for("gh", "pr", "create")
    return create[create.index("--body") + 1]
