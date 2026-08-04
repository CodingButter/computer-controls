"""What must never leave the machine, proved against a filed issue.

`test_nothing_sensitive_is_committed.py` asks whether a secret reached a git
object on the disk that recorded it. This file asks a stricter question about a
narrower thing. An episode stays home; an issue is on somebody else's server the
moment it is filed, and it is there permanently, indexed, and readable by anyone
who can read the repository. So the bar here is not "the policy held the secret
back" — it is "nothing the episode legitimately knows was copied out of it".

That distinction is what the second test in this file is for. A window title
belonging to an ordinary application is *not* withheld by the redaction policy:
it is in the episode, correctly, because whoever reads the episode is whoever
recorded it. The test asserts it is in the episode **and** absent from the issue.
A filer that quoted the record it was reading would pass every test written
against the policy and still put a stranger's name on the internet.
"""

from __future__ import annotations

import json

import pytest

from desktop_service import model, redaction, state

from episode_recorder import Review
from episode_recorder.filer import LEDGER
from recorder_tests.conftest import action, snapshot, window

SECRET = "hunter2-correct-horse"
PERSON = "Alice Nichols"
ADDRESS = "12 Rowan Street"


@pytest.fixture(autouse=True)
def real_policy():
    """The service's own redaction policy, installed exactly as in production."""
    previous = model.get_value_policy()
    model.set_value_policy(redaction.default_policy())
    yield
    model.set_value_policy(previous)


def sensitive_episode(recorder, agent, intent: str):
    """An episode with a password in it, a person's name, and a failing step.

    Everything a filer could possibly be tempted to copy is present: a secret in
    a password field, a person and their address in a window title, a message
    from that person in another field, and an error with a message attached.
    """
    empty = snapshot(1, window("win-a", active=True), values={"el-password": ""})
    typed = snapshot(
        2,
        window("win-a", active=True),
        state.WindowFacts(
            window_id="win-chat",
            application_id="app-2",
            application_name="Messages",
            title=f"{PERSON} — {ADDRESS}",
            role="frame",
            active=False,
        ),
        values={
            "el-password": model.egress_value(
                SECRET, field=model.VALUE, role="password text", element_id="el-password"
            ),
            "el-message": "meet me at six, the key is under the mat",
        },
    )

    episode = recorder.open(intent, agent)
    episode.step("type the password", "typeText", "el-password", action(empty, typed))
    episode.step("send it", "invokeElement", "el-send", action(typed, typed, ok=False))
    episode.close("could not send", worked=False)
    return episode


def everything_filed(board) -> str:
    """The whole of what reached the board, as one searchable string."""
    return "\n".join(
        issue["title"] + "\n" + issue["body"] + "\n" + " ".join(issue["labels"])
        + "\n" + issue["closed_with"]
        for issue in board.issues.values()
    )


def file_it(recorder, agent, reviewer, filer, **fields):
    """Take the same finding over the bar, so something is actually filed."""
    subject = filer()
    for intent in ("send the message", "send the message"):
        episode = sensitive_episode(recorder, agent, intent)
        review = Review(recorder.store.path, reviewer.author)
        step = review.steps(episode.branch)[-1]
        filing = subject.observe(
            review.find(episode.branch, step, "recurring-failure", **fields)
        )
    return filing


def test_no_secret_reaches_the_board(recorder, agent, reviewer, filer, board):
    filing = file_it(recorder, agent, reviewer, filer)
    assert filing.filed

    written = everything_filed(board)
    for forbidden in (SECRET, "hunter2", "under the mat", "meet me at six"):
        assert forbidden not in written


def test_what_the_episode_may_know_the_issue_may_not(recorder, agent, reviewer, filer, board):
    """The two-sided assertion, and the reason this file exists.

    An ordinary application's window title is not withheld from an episode — the
    policy has no reason to withhold it, and a reader of the episode is the
    machine's own owner. It is in the record. It must not be in the ticket, and
    nothing about the redaction policy would stop a filer that copied it.
    """
    filing = file_it(recorder, agent, reviewer, filer)

    recorded = recorder.store.git(
        "show", f"{filing.finding.occurrences[0].commit}:desktop/windows/win-chat.json"
    )
    assert PERSON in recorded, "the test is only meaningful if the episode really knows"
    assert ADDRESS in recorded

    written = everything_filed(board)
    assert PERSON not in written
    assert ADDRESS not in written
    assert "Messages" not in written


def test_the_summaries_the_delta_engine_wrote_do_not_travel(recorder, agent, reviewer, filer, board):
    """Not even the safe-looking prose.

    "A value grew by ten characters at the end" leaks nothing by itself, and it
    is still not filed. The rule is that a finding is built from enumerated
    fields rather than from text found in the record — a rule that admitted
    harmless prose would be a rule about prose, and it would be enforced by
    whoever was judging harmlessness at the time.
    """
    file_it(recorder, agent, reviewer, filer)
    written = everything_filed(board)

    assert "characters at the end" not in written
    assert "a window appeared" not in written
    # The service's error *message* is in the step record and does not travel
    # either; only the code does, because a code is an enum and a message is a
    # sentence somebody may one day interpolate a value into.
    assert "no tier could" not in written
    assert "ACTION_NOT_SUPPORTED" in written


def test_the_episode_is_named_by_commit_and_not_by_what_it_was_called(recorder, agent, reviewer, filer, board):
    """An intent is a sentence, and an agent's own sentences are not safe either.

    "message alice about the price" is written by the agent rather than read off
    the screen, which makes it feel different. It is not: it names a person, and
    it becomes a branch name that would otherwise be quoted straight into a
    ticket.
    """
    subject = filer()
    for _ in range(2):
        episode = sensitive_episode(recorder, agent, "message alice about the address")
        review = Review(recorder.store.path, reviewer.author)
        step = review.steps(episode.branch)[-1]
        filing = subject.observe(
            review.find(episode.branch, step, "recurring-failure")
        )

    assert filing.filed
    written = everything_filed(board)
    assert "alice" not in written.lower()
    assert episode.branch not in written
    # What it does say is an id, which is exact and useless without the store.
    assert filing.finding.occurrences[0].episode in written


def test_an_episode_id_cannot_be_guessed_back_into_a_sentence(recorder, agent, tmp_path):
    """The id is opaque only if it is salted, and the salt is the point.

    Anybody holding a filed issue also holds the two things a guess needs: the
    algorithm, which is in this repository, and a list of plausible intents,
    which is just English. Without salt they could confirm what an agent had
    been doing by hashing guesses until one matched. Two stores opened for the
    same work on the same second must therefore disagree — which rules out
    every salt that is a function of the clock, the path or the intent.
    """
    from episode_recorder import Recorder, Review, episode_id

    intent = "message alice about the address"
    here = recorder.open(intent, agent)
    elsewhere = Recorder(tmp_path / "another-machine").open(intent, agent)

    mine = Review(recorder.store.path, agent.author).episode_id(here.branch)
    theirs = Review(elsewhere.store.path, agent.author).episode_id(elsewhere.branch)

    # Same intent, same branch name, same agent — and no shared identifier.
    assert here.branch == elsewhere.branch
    assert mine != theirs
    # The guess an attacker can actually make is the unsalted one.
    assert mine != episode_id("", here.branch)
    # And with the store, it is exactly reproducible.
    assert mine == episode_id(recorder.store.identity(), here.branch)


def test_the_ledger_holds_the_line_too(recorder, agent, reviewer, filer, board):
    """The ledger is on the disk, but it is written by the same hand.

    It gets the same scan because a finding is stored there as the document that
    generated the issue: if a secret could survive in the ledger, it survived in
    the finding, and the next occurrence would file it.
    """
    filing = file_it(recorder, agent, reviewer, filer)
    entry = recorder.store.git(
        "show", f"{LEDGER}:findings/{filing.finding.signature}.json"
    )

    for forbidden in (SECRET, PERSON, ADDRESS, "under the mat"):
        assert forbidden not in entry
    # And it holds what it is for.
    assert json.loads(entry)["filed"]["number"] == filing.number
