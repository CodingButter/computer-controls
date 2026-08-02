"""An episode, read back the way somebody would read it.

These tests ask the questions a person asks of a recording: does the log say
what the work was, is one commit one deliberate action, does the diff show what
actually changed, and can you tell an attempt that worked from one that did not.
"""

from __future__ import annotations

import json

import pytest

from episode_recorder import branch_name
from episode_recorder.store import IDENTITY_DOMAIN, UNLABELLED

from recorder_tests.conftest import action, snapshot, window


def test_an_episode_is_a_branch_named_for_what_it_set_out_to_do(recorder, agent):
    episode = recorder.open("sell the PS5", agent)
    assert episode.branch == "sell-the-ps5"
    assert "sell-the-ps5" in recorder.store.branches()


def test_a_second_attempt_at_the_same_task_gets_its_own_branch(recorder, agent):
    # Two goes at one task is the normal case, not a name clash to be avoided.
    first = recorder.open("sell the PS5", agent)
    first.close(worked=False)
    second = recorder.open("sell the PS5", agent)
    assert second.branch == "sell-the-ps5-2"


def test_the_log_reads_as_an_account_of_the_work(recorder, agent):
    before = snapshot(1, window("win-a"))
    opened = snapshot(2, window("win-a"), window("win-b", title="New Listing"))
    listed = snapshot(3, window("win-a"), window("win-b"), values={"el-price": "520"})
    grown = snapshot(4, window("win-a"), window("win-b"), values={"el-price": "520.00"})

    episode = recorder.open("sell the PS5", agent)
    episode.step("open the listing form", "invokeElement", "el-sell", action(before, opened))
    episode.step("put in the price", "typeText", "el-price", action(listed, grown))
    episode.close("sold for 520", worked=True)

    assert recorder.store.subjects(episode.branch) == [
        "sell the PS5",
        "open the listing form",
        "put in the price",
    ]


def test_one_deliberate_action_is_one_commit(recorder, agent):
    # The desktop churns; a branch that committed every twitch would be a log of
    # the screen rather than of the work.
    busy = snapshot(1, window("win-a"))
    noisier = snapshot(
        2,
        window("win-a"),
        window("win-b"),
        window("win-c"),
        window("win-d"),
    )
    episode = recorder.open("do one thing", agent)
    episode.step("the one thing", "invokeElement", "el-go", action(busy, noisier))

    # Four windows moved. One decision was taken. One commit.
    assert len(recorder.store.subjects(episode.branch)) == 2


def test_the_commit_is_authored_by_the_identity_the_service_issued(recorder, agent):
    episode = recorder.open("sell the PS5", agent)
    author = recorder.store.git("log", "-1", "--format=%an <%ae>", episode.branch)
    assert author == f"lister <cl-1a2b3c4d@{IDENTITY_DOMAIN}>"


def test_a_client_that_named_itself_nothing_is_still_exactly_identified(recorder, agent):
    # The label is a claim and the id is a fact. A missing claim must not blur
    # the fact — the address still says which connection did this.
    from episode_recorder import Agent

    quiet = Agent(client_id="cl-deadbeef")
    episode = recorder.open("say nothing", quiet)
    author = recorder.store.git("log", "-1", "--format=%an <%ae>", episode.branch)
    assert author == f"{UNLABELLED} <cl-deadbeef@{IDENTITY_DOMAIN}>"


def test_the_message_carries_the_facts_a_reader_would_open_the_file_for(recorder, agent):
    before = snapshot(1, window("win-a"))
    after = snapshot(7, window("win-a"), window("win-b"))
    episode = recorder.open("sell the PS5", agent)
    episode.step(
        "open the listing form",
        "invokeElement",
        "el-sell",
        action(before, after, action_id="act-77", fallbacks=("accessibility",), backend="compositor"),
    )

    message = recorder.store.git("log", "-1", "--format=%B", episode.branch)
    assert "open the listing form" in message
    assert "Action-Id: act-77" in message
    assert "Revision-Range: 1..7" in message
    assert "Backend: compositor" in message
    assert "Fallbacks-Used: accessibility" in message


def test_an_incomplete_settle_says_so_in_the_message(recorder, agent):
    # A partial settle means effects may still be arriving. A commit that stayed
    # quiet about it would let a reader read a short diff as a small effect.
    before = snapshot(1, window("win-a"))
    after = snapshot(2, window("win-a"), window("win-b"))
    episode = recorder.open("sell the PS5", agent)
    episode.step("click it", "invokeElement", "el-sell", action(before, after, partial=True))
    assert "Partial: true" in recorder.store.git("log", "-1", "--format=%B", episode.branch)


def test_an_action_that_failed_is_still_a_step(recorder, agent):
    # An agent that tried and was refused is a fact about the agent, and it is
    # invisible in a record that only keeps what worked.
    steady = snapshot(1, window("win-a"))
    episode = recorder.open("sell the PS5", agent)
    episode.step("click the missing button", "invokeElement", "el-gone", action(steady, steady, ok=False))

    assert "Failed: ACTION_NOT_SUPPORTED" in recorder.store.git("log", "-1", "--format=%B")
    record = json.loads(recorder.store.git("show", f"{episode.branch}:steps/0001.json"))
    assert record["ok"] is False
    assert record["error"]["code"] == "ACTION_NOT_SUPPORTED"


def test_an_episode_that_worked_becomes_canon(recorder, agent):
    before = snapshot(1, window("win-a"))
    after = snapshot(2, window("win-a"), window("win-b"))
    episode = recorder.open("sell the PS5", agent)
    episode.step("click it", "invokeElement", "el-sell", action(before, after))
    episode.close("sold for 520", worked=True)

    assert episode.branch in recorder.store.merged_branches()
    assert "sold-for-520" in recorder.store.git("tag", "--list").splitlines()


def test_an_attempt_that_went_sideways_stays_readable_and_unmerged(recorder, agent):
    steady = snapshot(1, window("win-a"))
    episode = recorder.open("sell the PS5", agent)
    episode.step("click the wrong thing", "invokeElement", "el-nope", action(steady, steady, ok=False))
    episode.close(worked=False)

    assert episode.branch not in recorder.store.merged_branches()
    # Readable, though: not merged is not deleted.
    assert recorder.store.subjects(episode.branch) == ["sell the PS5", "click the wrong thing"]


def test_a_closed_episode_refuses_further_steps(recorder, agent):
    steady = snapshot(1, window("win-a"))
    episode = recorder.open("sell the PS5", agent)
    episode.close(worked=False)
    with pytest.raises(RuntimeError):
        episode.step("one more", "invokeElement", "el-a", action(steady, steady))


def test_an_intent_that_is_all_punctuation_still_names_a_branch():
    assert branch_name("!!!") == "episode"
    assert branch_name("Sell the PS5 — quickly!") == "sell-the-ps5-quickly"
