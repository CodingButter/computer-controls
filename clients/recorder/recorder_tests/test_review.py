"""A second agent reading work it did not do, and saying something useful about it.

The bar these tests hold is the one from the issue: a review names specific
steps, has the diff of those steps in front of it, and ends as a proposed change
to the agent's own files rather than as a verdict. A score out of ten would pass
none of them, which is the point.
"""

from __future__ import annotations

import pytest

from episode_recorder import Review
from episode_recorder.store import IDENTITY_DOMAIN

from recorder_tests.conftest import action, snapshot, window


@pytest.fixture
def performed(recorder, agent):
    """An episode somebody else did, four steps long."""
    # The price field starts empty rather than absent: `state.diff` reports a
    # value change only for an element it already knew about, so a field the
    # service has never seen produces no delta at all on its first edit.
    empty = snapshot(1, window("win-a", active=True))
    opened = snapshot(2, window("win-a"), window("win-b", title="New Listing"), values={"el-price": ""})
    priced = snapshot(3, window("win-a"), window("win-b"), values={"el-price": "50"})
    fixed = snapshot(4, window("win-a"), window("win-b"), values={"el-price": "500"})

    episode = recorder.open("sell the PS5", agent)
    episode.step("open the listing form", "invokeElement", "el-sell", action(empty, opened))
    episode.step("type the price", "typeText", "el-price", action(opened, priced))
    episode.step("fix the price", "typeText", "el-price", action(priced, fixed))
    episode.step("post it", "invokeElement", "el-post", action(fixed, fixed))
    episode.close("sold for 500", worked=True)
    return episode


def test_a_reviewer_reads_the_steps_of_an_episode_it_did_not_perform(recorder, performed, reviewer):
    review = Review(recorder.store.path, reviewer.author)
    steps = review.steps(performed.branch)

    assert [step.number for step in steps] == [1, 2, 3, 4]
    assert [step.intent for step in steps] == [
        "open the listing form",
        "type the price",
        "fix the price",
        "post it",
    ]
    # The declaration is not a step. It is the brief.
    assert all(step.method for step in steps)


def test_a_reviewer_sees_the_diff_of_the_step_it_is_judging(recorder, performed, reviewer):
    review = Review(recorder.store.path, reviewer.author)
    second = review.steps(performed.branch)[1]

    diff = review.diff(second.commit)
    assert "desktop/elements/el-price.json" in diff
    assert "steps/0002.json" in diff


def test_a_reviewer_reads_what_the_agent_was_told(recorder, performed, reviewer):
    # Judging an outcome without the brief is how a good agent gets blamed for
    # a bad one.
    review = Review(recorder.store.path, reviewer.author)
    files = review.agent_files(performed.branch)

    assert files["agent/model.txt"] == "claude-opus-5"
    assert "Do not haggle" in files["agent/instructions.md"]
    assert "desktop_type_text" in files["agent/tools.json"]


def test_a_remark_lands_on_the_step_it_is_about_and_no_other(recorder, performed, reviewer):
    review = Review(recorder.store.path, reviewer.author)
    steps = review.steps(performed.branch)

    review.remark(steps[1], "typed 50 into a price field that wanted 500")
    review.remark(steps[2], "the fix worked, but it was two edits where one would do")

    assert "typed 50" in review.remarks(steps[1])
    assert "two edits" in review.remarks(steps[2])
    assert review.remarks(steps[0]) == ""
    assert review.remarks(steps[3]) == ""


def test_a_remark_does_not_rewrite_the_episode(recorder, performed, reviewer):
    # A reviewer who could edit the record would be editing the past.
    before = recorder.store.git("rev-parse", performed.branch)
    review = Review(recorder.store.path, reviewer.author)
    review.remark(review.steps(performed.branch)[0], "fine")

    assert recorder.store.git("rev-parse", performed.branch) == before


def test_a_remark_is_attributable_to_the_agent_that_made_it(recorder, performed, reviewer):
    review = Review(recorder.store.path, reviewer.author)
    review.remark(review.steps(performed.branch)[0], "fine")

    author = recorder.store.git(
        "log", "-1", "--format=%an <%ae>", "refs/notes/reviews"
    )
    assert author == f"auditor <cl-99887766@{IDENTITY_DOMAIN}>"


def test_the_conclusion_lands_as_a_change_to_the_agents_own_files(recorder, performed, reviewer, agent):
    # A lesson written as a comment has to be read, agreed with and applied by
    # hand. A lesson written as a diff is already the shape of the fix.
    review = Review(recorder.store.path, reviewer.author)
    proposed = review.propose(
        performed.branch,
        agent.instructions + "\nCheck a price field reads back what you meant before posting.",
        "reviewing sell-the-ps5: two edits to one price field",
    )

    diff = recorder.store.git("show", "--format=", proposed)
    assert "agent/instructions.md" in diff
    assert "+Check a price field reads back" in diff
    assert f"review/{performed.branch}" in recorder.store.branches()


def test_the_proposal_is_not_canon_until_somebody_merges_it(recorder, performed, reviewer, agent):
    review = Review(recorder.store.path, reviewer.author)
    review.propose(performed.branch, agent.instructions + "\nBe careful.", "a suggestion")

    assert f"review/{performed.branch}" not in recorder.store.merged_branches()
