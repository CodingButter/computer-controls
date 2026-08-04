"""The bar and the cap, held against the two rules that make filing bearable.

An agent that files after every task produces a hundred tickets a day. The
ruling answers that with two rules rather than one, and they are tested apart
because they fail apart: the bar decides whether a thing is worth saying at all,
and the cap decides whether it is worth saying *instead of* something this filer
has already said.

The episodes here are recorded by the real recorder over the service's real diff
engine, and the findings are built by the real reviewer out of the committed
step records. Nothing hands the filer a finding it made up, because the property
under test is that a conclusion travels from an episode to a board with nobody
carrying it — and a test that started at the finding would have skipped the part
that has to work.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from episode_recorder import Finding, NotFileable, Occurrence, Review
from episode_recorder.filer import FILING_ENV, LEDGER
from episode_recorder.finding import ERROR, METHOD, ROLES
from episode_recorder.store import Author

from recorder_tests.conftest import action, snapshot, window

SCHEMA = json.loads(
    (Path(__file__).resolve().parents[3] / "protocol" / "schema.json").read_text()
)

#: The labels this board already uses. Written out here rather than imported,
#: because the assertion worth making is that the filer invents nothing — and a
#: list the filer also owns could not catch it inventing something.
BOARD_LABELS = {
    "bug",
    "enhancement",
    "amendment",
    "sandbox-safe",
    "needs:desktop",
    "area:client",
    "area:plugin",
    "area:protocol",
    "area:service",
}


def a_failed_attempt(recorder, agent, intent: str = "post the listing"):
    """An episode in which one action fails, recorded the way a real one is."""
    before = snapshot(1, window("win-a", active=True), values={"el-post": ""})
    after = snapshot(2, window("win-a"), values={"el-post": ""})

    episode = recorder.open(intent, agent)
    episode.step("post it", "invokeElement", "el-post", action(before, after, ok=False))
    episode.close("could not post", worked=False)
    return episode


def concluded(recorder, reviewer, episode, kind="recurring-failure", **fields) -> Finding:
    """What a reviewing agent concluded about the failing step of an episode."""
    review = Review(recorder.store.path, reviewer.author)
    step = review.steps(episode.branch)[-1]
    return review.find(episode.branch, step, kind, **fields)


# -- the bar ------------------------------------------------------------


def test_nothing_is_filed_on_a_first_occurrence(recorder, agent, reviewer, filer, board):
    once = a_failed_attempt(recorder, agent)
    filing = filer().observe(concluded(recorder, reviewer, once))

    assert not filing.filed
    assert board.issues == {}
    assert "once is an incident" in filing.reason


def test_a_first_occurrence_is_still_recorded(recorder, agent, reviewer, filer):
    # It is not filed and it is not discarded. The ledger is the only reason a
    # second occurrence can ever be recognised as a second one.
    once = a_failed_attempt(recorder, agent)
    finding = concluded(recorder, reviewer, once)
    filer().observe(finding)

    written = recorder.store.git("show", f"{LEDGER}:findings/{finding.signature}.json")
    assert json.loads(written)["finding"]["occurrences"][0]["step"] == 1


def test_a_second_occurrence_across_distinct_episodes_is_filed(recorder, agent, reviewer, filer, board):
    first = a_failed_attempt(recorder, agent)
    second = a_failed_attempt(recorder, agent)
    assert first.branch != second.branch

    subject = filer()
    subject.observe(concluded(recorder, reviewer, first))
    filing = subject.observe(concluded(recorder, reviewer, second))

    assert filing.filed
    assert board.only()["title"].startswith("lister:")


def test_the_filed_issue_names_both_occurrences(recorder, agent, reviewer, filer, board):
    first = a_failed_attempt(recorder, agent)
    second = a_failed_attempt(recorder, agent)
    review = Review(recorder.store.path, reviewer.author)

    subject = filer()
    subject.observe(concluded(recorder, reviewer, first))
    subject.observe(concluded(recorder, reviewer, second))

    body = board.only()["body"]
    for episode in (first, second):
        # Named by its episode id, because an episode's branch name is the
        # sentence somebody wrote about what they were doing.
        assert review.episode_id(episode.branch) in body
        assert episode.branch not in body
    assert "2 distinct episodes" in body


def test_twice_in_one_episode_is_not_a_pattern(recorder, agent, reviewer, filer, board):
    """The bar is two episodes, not two occurrences.

    The same wrong turn twice inside one task is one wrong turn that did not get
    better, and it is exactly what the episode is already a record of. A pattern
    is the thing that survived the end of a task and came back.
    """
    before = snapshot(1, window("win-a", active=True))
    after = snapshot(2, window("win-a"))
    episode = recorder.open("try twice", agent)
    episode.step("post it", "invokeElement", "el-post", action(before, after, ok=False))
    episode.step("post it again", "invokeElement", "el-post", action(after, after, ok=False))

    review = Review(recorder.store.path, reviewer.author)
    subject = filer()
    for step in review.steps(episode.branch):
        filing = subject.observe(
            review.find(episode.branch, step, "recurring-failure")
        )

    assert len(filing.finding.occurrences) == 2
    assert len(filing.finding.episodes) == 1
    assert not filing.filed
    assert board.issues == {}


def test_a_finding_is_not_filed_twice(recorder, agent, reviewer, filer, board):
    episodes = [a_failed_attempt(recorder, agent) for _ in range(3)]
    subject = filer()
    filings = [subject.observe(concluded(recorder, reviewer, e)) for e in episodes]

    assert len(board.issues) == 1
    assert filings[2].number == filings[1].number
    assert "already filed" in filings[2].reason


def test_an_element_handle_does_not_make_two_findings_different(recorder, agent, reviewer):
    """The recurrence bar has to survive a new session.

    An element id is a handle issued for one session, so the same wrong turn
    tomorrow names a different element. A signature that included it would score
    every recurrence as a first occurrence — a bar that never fires, which is
    indistinguishable from no bar until somebody goes looking for the issues it
    never filed.
    """
    agent_id = Author(client_id="cl-1a2b3c4d", label="lister")
    here = Finding(kind="recurring-failure", agent=agent_id, method="invokeElement", target="el-1")
    there = Finding(kind="recurring-failure", agent=agent_id, method="invokeElement", target="el-99")

    assert here.signature == there.signature


# -- the cap ------------------------------------------------------------


def fill(subject, recorder, agent, reviewer, indices, kind="skill"):
    """Put one distinct finding per index onto the board, over the bar each time.

    The index rides in on the tool name, which is part of what makes two
    findings different — without it these would all be the same finding seen
    many times, which is a different test.
    """
    for index in indices:
        pair = [
            a_failed_attempt(recorder, agent, f"do the thing {index}") for _ in range(2)
        ]
        for episode in pair:
            filing = subject.observe(
                concluded(recorder, reviewer, episode, kind=kind, tool=f"tool_{index}")
            )
    return filing


def test_a_filer_cannot_exceed_its_cap(recorder, agent, reviewer, filer, board):
    subject = filer(cap=2)
    fill(subject, recorder, agent, reviewer, [0, 1])
    assert len(board.open_issues()) == 2

    # A third finding of the same kind and the same weight: nothing to choose
    # between them, so the board is not asked to hold a third.
    more = fill(subject, recorder, agent, reviewer, [2])

    assert not more.filed
    assert len(board.open_issues()) == 2
    assert "at the cap" in more.reason


def test_at_the_cap_it_withdraws_its_own_weakest_and_says_why(recorder, agent, reviewer, filer, board):
    subject = filer(cap=1)
    fill(subject, recorder, agent, reviewer, [0], kind="skill")
    weakest = board.only()

    failures = [a_failed_attempt(recorder, agent, "post it") for _ in range(2)]
    for episode in failures:
        filing = subject.observe(concluded(recorder, reviewer, episode))

    assert filing.filed
    assert filing.withdrew == 1
    assert board.issues[1]["state"] == "closed"
    assert weakest["state"] == "closed"
    # The reason is a comparison a reader can check, not an apology.
    assert "at its cap" in board.issues[1]["closed_with"]
    assert "recurring-failure" in board.issues[1]["closed_with"]
    assert len(board.open_issues()) == 1


def test_the_withdrawal_is_part_of_the_record(recorder, agent, reviewer, filer, board):
    subject = filer(cap=1)
    weak = fill(subject, recorder, agent, reviewer, [0], kind="skill")

    for episode in [a_failed_attempt(recorder, agent, "post it") for _ in range(2)]:
        strong = subject.observe(concluded(recorder, reviewer, episode))

    entry = json.loads(
        recorder.store.git("show", f"{LEDGER}:findings/{weak.finding.signature}.json")
    )
    withdrawn = entry["filed"]["withdrawn"]
    assert withdrawn["number"] == 1
    assert withdrawn["forSignature"] == strong.finding.signature
    assert "at its cap" in withdrawn["reason"]
    # Nothing about the occurrences was deleted by the withdrawal.
    assert entry["finding"]["occurrences"]


def test_an_open_issue_the_ledger_cannot_account_for_is_never_withdrawn(recorder, agent, reviewer, filer, board):
    """Not knowing what something is, is not evidence that it is unimportant.

    Withdrawing is the one move here that reaches out and changes somebody
    else's board, so it is the one that refuses to act on a guess.
    """
    # The cap is two, and the filer can account for exactly one of the two open
    # issues. The one it can account for is weaker than what it has just found,
    # so a filer that only counted would withdraw it — and the issue it cannot
    # account for is the one that should have stopped it.
    subject = filer(cap=2)
    fill(subject, recorder, agent, reviewer, [0], kind="skill")
    mine = board.only()
    board.unaccounted = {404}

    for episode in [a_failed_attempt(recorder, agent, "post it") for _ in range(2)]:
        filing = subject.observe(concluded(recorder, reviewer, episode))

    assert not filing.filed
    assert mine["state"] == "open"
    assert len(board.issues) == 1
    assert "at the cap" in filing.reason


# -- what lands on the board -------------------------------------------


def test_the_issue_is_filed_against_the_agent_whose_behaviour_it_is(recorder, agent, reviewer, filer, board):
    subject = filer()
    for episode in [a_failed_attempt(recorder, agent) for _ in range(2)]:
        subject.observe(concluded(recorder, reviewer, episode))

    body = board.only()["body"]
    assert "lister" in body
    assert "filed-against cl-1a2b3c4d" in body
    # The cap belongs to whoever filed, which is not whoever is being filed
    # about. Everything through one machine account has the same author, so the
    # trailer is the only thing that can tell two filers apart.
    assert "filed-by cl-99887766" in body


def test_it_carries_the_routing_labels_this_board_already_uses(recorder, agent, reviewer, filer, board):
    subject = filer()
    for episode in [a_failed_attempt(recorder, agent) for _ in range(2)]:
        subject.observe(concluded(recorder, reviewer, episode))

    labels = set(board.only()["labels"])
    assert labels <= BOARD_LABELS, f"invented a label: {sorted(labels - BOARD_LABELS)}"
    assert labels == {"bug", "sandbox-safe", "area:client"}


def test_a_finding_only_a_desktop_can_judge_says_so(recorder, agent, reviewer, filer, board):
    subject = filer()
    for episode in [a_failed_attempt(recorder, agent) for _ in range(2)]:
        filing = subject.observe(
            concluded(recorder, reviewer, episode, needs_desktop=True)
        )

    assert "needs:desktop" in filing.labels
    assert "sandbox-safe" not in filing.labels


def test_a_worker_arriving_cold_is_told_enough_to_act(recorder, agent, reviewer, filer, board):
    """The issue body is that worker's entire world.

    So the test is not that the body is non-empty; it is that each of the
    questions somebody picking this up would have to answer is answered in it —
    what happened, how often, to which agent, and what would count as done.
    """
    subject = filer()
    for episode in [a_failed_attempt(recorder, agent) for _ in range(2)]:
        subject.observe(concluded(recorder, reviewer, episode, role="push button"))

    body = board.only()["body"]
    for heading in ("What recurred", "The occurrences", "Filed against", "What would close this"):
        assert f"## {heading}" in body
    assert "invokeElement" in body
    assert "ACTION_NOT_SUPPORTED" in body
    assert "push button" in body
    assert "2 distinct episodes" in body


# -- the switch ---------------------------------------------------------


def test_filing_is_off_until_somebody_turns_it_on(recorder, agent, reviewer, filer, board):
    subject = filer(enabled=None, environ={})
    for episode in [a_failed_attempt(recorder, agent) for _ in range(2)]:
        filing = subject.observe(concluded(recorder, reviewer, episode))

    assert not filing.filed
    assert board.issues == {}
    assert FILING_ENV in filing.reason


def test_switched_off_it_still_shows_what_it_would_have_filed(recorder, agent, reviewer, filer):
    """Off by default *until the bar has been observed to hold*.

    An off switch that also stopped the observing would make that condition
    impossible to satisfy: there would be no way to find out whether the bar
    fires on the right things without first trusting it with a live board.
    """
    subject = filer(enabled=None, environ={})
    for episode in [a_failed_attempt(recorder, agent) for _ in range(2)]:
        filing = subject.observe(concluded(recorder, reviewer, episode))

    assert filing.title.startswith("lister:")
    assert "## What recurred" in filing.body
    assert len(filing.finding.episodes) == 2


def test_any_value_turns_it_on_because_typing_it_is_the_statement(recorder, agent, reviewer, filer, board):
    # The same reading as DESKTOP_HUMAN_PRESENT: set or not set. A truthiness
    # table would only be a second rule to learn.
    subject = filer(enabled=None, environ={FILING_ENV: "0"})
    for episode in [a_failed_attempt(recorder, agent) for _ in range(2)]:
        subject.observe(concluded(recorder, reviewer, episode))

    assert len(board.issues) == 1


# -- the shapes ---------------------------------------------------------


def test_the_shapes_admit_the_protocol_they_describe():
    """A shape that stopped admitting the real vocabulary fails here, not quietly.

    `finding.py` constrains a method or an error code by shape rather than by a
    list, so that the recorder stays a standalone client with no path back to
    this repository at runtime. That trade is only honest if something holds the
    shapes against the real thing.
    """
    for method in SCHEMA["methods"]:
        assert METHOD.fullmatch(method), method
    for code in SCHEMA["enums"]["errorCode"]["values"]:
        assert ERROR.fullmatch(code), code


def test_the_roles_the_service_knows_are_roles_a_finding_can_name():
    """The one closed list in `finding.py`, held against the service's own.

    A role is a vocabulary rather than a shape, which buys the redaction line a
    guarantee no regex can give — and costs the risk that a backend learns a
    role this list has never heard of, leaving a reviewer with a real finding
    and no way to file it. That failure should arrive here, on a named list,
    rather than as a `NotFileable` in front of an agent that did nothing wrong.
    """
    from desktop_service import probe, redaction
    from desktop_service.backends import atspi

    known = (
        probe.EDITABLE_ROLES
        | atspi.WINDOW_ROLES
        | atspi.TEXT_VALUE_ROLES
        | redaction.SECRET_ROLES
    )
    # `password_text` and `passwordtext` are spellings redaction folds together
    # before comparing, so that a backend writing either is still recognised.
    # The vocabulary holds the spelling AT-SPI actually reports.
    spellings = {"password_text", "passwordtext"}
    unknown = (known - spellings) - ROLES
    assert not unknown, f"roles the service uses that a finding cannot name: {unknown}"


@pytest.mark.parametrize(
    "field, value",
    [
        ("role", "hunter2-correct-horse"),
        ("role", "the price field said 500"),
        ("method", "he lives at 12 Rowan Street"),
        ("tool", "message from Alice: see you at six"),
        ("target", "a sentence, with punctuation"),
        ("role", "button\nand a second line"),
        # Lower-case, no digits, no punctuation, no newline: it passes every
        # shape a role could be held to, and it is a person's name. This is the
        # case a vocabulary exists for.
        ("role", "alice"),
        ("role", "jamie nichols"),
        ("role", "sell the ps5"),
    ],
)
def test_a_finding_refuses_anything_shaped_like_a_sentence(field, value):
    with pytest.raises(NotFileable):
        Finding(
            kind="recurring-failure",
            agent=Author(client_id="cl-1", label="lister"),
            **{field: value},
        )


def test_a_finding_refuses_a_kind_or_an_area_nobody_enumerated():
    agent_id = Author(client_id="cl-1", label="lister")
    with pytest.raises(NotFileable):
        Finding(kind="vibes", agent=agent_id)
    with pytest.raises(NotFileable):
        Finding(kind="skill", agent=agent_id, area="area:whatever")


def test_an_occurrence_is_a_commit_and_a_step_and_nothing_else():
    with pytest.raises(NotFileable):
        Occurrence(episode="sell-the-ps5", step=1, commit="abc1234")


# -- keeping out of the episode's way -----------------------------------


def test_filing_leaves_the_working_tree_where_it_found_it(recorder, agent, reviewer, filer):
    """A filer that wandered off would write somebody's next step into the ledger.

    An episode commits onto whatever branch is checked out, and the filer has to
    stand on another one to write the ledger. Putting it back is not politeness;
    it is what keeps the two records from becoming one.
    """
    a_failed_attempt(recorder, agent)
    second = a_failed_attempt(recorder, agent)

    open_now = recorder.open("keep going", agent)
    review = Review(recorder.store.path, reviewer.author)
    step = review.steps(second.branch)[-1]
    filer().observe(review.find(second.branch, step, "recurring-failure"))

    steady = snapshot(1, window("win-a", active=True))
    open_now.step("carry on", "invokeElement", "el-next", action(steady, steady))

    assert recorder.store.current_branch() == open_now.branch
    assert "steps/0001.json" in recorder.store.git(
        "show", "--name-only", "--format=", open_now.branch
    )
