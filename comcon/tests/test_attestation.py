"""The proof an agent cannot author, tested without a desktop.

A verdict is a photograph the service takes below the agent's layer. These
tests prove the photograph is honest in the ways that matter: it stamps the
revision it was taken at, it reports a criterion it cannot decide as unchecked
rather than verified, it notices a field that moved and moved back, and the
rubric it is judged against cannot be narrowed by the party being judged.
"""

from __future__ import annotations

from desktop_service import attestation
from desktop_service.attestation import (
    CONTENTS_MATCH,
    INTENT_MATCHES,
    MECHANICAL_CRITERIA,
    MISMATCH,
    RIGHT_RECIPIENT,
    TARGET_RESOLVED,
    UNCHANGED_SINCE_PROOF,
    UNCHECKED,
    VERIFIED,
    Movement,
    Observed,
    evaluate,
    movement,
    resolve,
)


def observed(**overrides) -> Observed:
    """A commit where everything the service could check checked out."""
    facts = {
        "target_resolved": True,
        "contents_match": True,
        "proof_revision": 42,
        "commit_revision": 42,
        "movement": Movement(),
    }
    facts.update(overrides)
    return Observed(**facts)


def verdict_for(criterion, **overrides):
    results = evaluate(resolve(()), observed(**overrides)).results
    return next(r for r in results if r.criterion.name == criterion.name)


# ---------------------------------------------------------------------------
# resolve — the rubric the worker does not write
# ---------------------------------------------------------------------------


def test_declaring_nothing_still_gets_the_mechanical_criteria() -> None:
    """Silence cannot buy a commit fewer questions."""
    assert resolve(()) == MECHANICAL_CRITERIA


def test_a_declared_criterion_adds_to_the_mechanical_set() -> None:
    criteria = resolve(["right-recipient"])

    assert set(MECHANICAL_CRITERIA).issubset(criteria)
    assert RIGHT_RECIPIENT in criteria


def test_a_grant_cannot_drop_a_mechanical_criterion() -> None:
    """Naming one question is not a way of declining the others."""
    criteria = resolve(["intent-matches"])

    for mechanical in MECHANICAL_CRITERIA:
        assert mechanical in criteria


def test_an_unknown_criterion_survives_as_a_judgement_question() -> None:
    """A question this service cannot answer still reaches the reviewer."""
    criteria = resolve(["is-this-the-agreed-price"])
    named = next(c for c in criteria if c.name == "is-this-the-agreed-price")

    assert named.mechanical is False


def test_a_criterion_named_twice_is_asked_once() -> None:
    criteria = resolve(["right-recipient", "right-recipient"])

    assert [c.name for c in criteria].count("right-recipient") == 1


# ---------------------------------------------------------------------------
# evaluate — the mechanical criteria
# ---------------------------------------------------------------------------


def test_a_clean_commit_verifies_every_mechanical_criterion() -> None:
    result = evaluate(resolve(()), observed())

    assert result.clean
    assert all(r.verdict == VERIFIED for r in result.results)
    assert result.proof_revision == 42


def test_the_verdict_carries_the_revision_it_was_stamped_at() -> None:
    result = evaluate(resolve(()), observed(proof_revision=7, commit_revision=7))

    assert result.proof_revision == 7
    assert result.summary.startswith("r7 ")


def test_a_target_the_desktop_no_longer_has_is_a_mismatch() -> None:
    result = verdict_for(TARGET_RESOLVED, target_resolved=False)

    assert result.verdict == MISMATCH


def test_contents_that_moved_are_a_mismatch() -> None:
    result = verdict_for(CONTENTS_MATCH, contents_match=False)

    assert result.verdict == MISMATCH


def test_contents_that_could_not_be_read_are_unchecked_never_verified() -> None:
    """A masked field is the case: bullets prove nothing either way."""
    result = verdict_for(CONTENTS_MATCH, contents_match=None)

    assert result.verdict == UNCHECKED
    assert result.verdict != VERIFIED


def test_an_unreadable_field_does_not_pass_the_gate() -> None:
    assert not evaluate(resolve(()), observed(contents_match=None)).clean


# ---------------------------------------------------------------------------
# Freshness — the question contents-equality cannot answer
# ---------------------------------------------------------------------------


def test_a_field_nobody_else_touched_is_fresh() -> None:
    result = verdict_for(UNCHANGED_SINCE_PROOF, commit_revision=99)

    assert result.verdict == VERIFIED


def test_a_field_another_party_touched_is_stale() -> None:
    """The ABA case: identical text, and the field still moved."""
    result = verdict_for(
        UNCHANGED_SINCE_PROOF,
        contents_match=True,
        commit_revision=43,
        movement=Movement(foreign=1),
    )

    assert result.verdict == MISMATCH
    assert "another party" in result.detail


def test_a_stale_field_fails_the_gate_even_with_matching_contents() -> None:
    result = evaluate(
        resolve(()),
        observed(contents_match=True, movement=Movement(foreign=1)),
    )

    assert not result.clean
    assert [r.criterion.name for r in result.failures] == [
        UNCHANGED_SINCE_PROOF.name
    ]


def test_a_change_nobody_can_account_for_is_unchecked_never_verified() -> None:
    result = verdict_for(
        UNCHANGED_SINCE_PROOF, movement=Movement(unattributed=1)
    )

    assert result.verdict == UNCHECKED
    assert result.verdict != VERIFIED


def test_a_change_log_that_lost_the_proof_revision_is_unchecked() -> None:
    """Silence from a log that cannot see that far back proves nothing."""
    result = verdict_for(UNCHANGED_SINCE_PROOF, movement=Movement(complete=False))

    assert result.verdict == UNCHECKED
    assert "cannot be ruled out" in result.detail


def test_a_revision_that_went_backwards_is_unchecked() -> None:
    result = verdict_for(
        UNCHANGED_SINCE_PROOF, proof_revision=42, commit_revision=41
    )

    assert result.verdict == UNCHECKED


# ---------------------------------------------------------------------------
# movement — reading the delta engine's own record
# ---------------------------------------------------------------------------


def delta(changes, complete=True):
    return {"changes": changes, "revision": 50, "complete": complete}


def test_a_change_to_another_element_is_not_this_field_moving() -> None:
    moved = movement(
        "el-1",
        delta([{"elementId": "el-2", "attribution": "external", "revision": 43}]),
    )

    assert moved == Movement(foreign=0, unattributed=0, complete=True)


def test_the_committing_clients_own_change_is_not_interference() -> None:
    moved = movement(
        "el-1",
        delta([{"elementId": "el-1", "attribution": "self", "revision": 43}]),
    )

    assert moved.foreign == 0
    assert moved.unattributed == 0


def test_another_clients_change_counts_as_foreign() -> None:
    moved = movement(
        "el-1",
        delta([{"elementId": "el-1", "attribution": "external", "revision": 43}]),
    )

    assert moved.foreign == 1


def test_an_unattributed_change_is_counted_apart_from_a_foreign_one() -> None:
    moved = movement(
        "el-1",
        delta(
            [
                {"elementId": "el-1", "attribution": "unattributed", "revision": 43},
                {"elementId": "el-1", "attribution": "external", "revision": 44},
            ]
        ),
    )

    assert moved == Movement(foreign=1, unattributed=1, complete=True)


def test_an_incomplete_delta_carries_its_incompleteness() -> None:
    assert movement("el-1", delta([], complete=False)).complete is False


def test_a_delta_that_is_not_a_report_at_all_is_incomplete() -> None:
    """No answer is not a clean answer."""
    assert movement("el-1", None).complete is False


# ---------------------------------------------------------------------------
# Judgement criteria — named here so they can be reported unanswered
# ---------------------------------------------------------------------------


def test_a_judgement_criterion_is_reported_not_decided() -> None:
    result = evaluate(resolve(["right-recipient", "intent-matches"]), observed())
    names = {r.criterion.name: r.verdict for r in result.results}

    assert names[RIGHT_RECIPIENT.name] == UNCHECKED
    assert names[INTENT_MATCHES.name] == UNCHECKED


def test_an_unanswerable_judgement_criterion_does_not_hold_the_gate_shut() -> None:
    """A gate waiting for a reviewer's answer would never open at all."""
    result = evaluate(resolve(["right-recipient"]), observed())

    assert result.clean


def test_the_summary_reports_verdicts_and_never_contents() -> None:
    result = evaluate(
        resolve(["right-recipient"]),
        observed(contents_match=False),
    )

    assert "contents-match=mismatch" in result.summary
    assert "right-recipient=unchecked" in result.summary
    assert "hello" not in result.summary


def test_every_criterion_appears_in_the_summary() -> None:
    criteria = resolve(["right-recipient", "intent-matches"])
    summary = evaluate(criteria, observed()).summary

    for criterion in criteria:
        assert f"{criterion.name}=" in summary


def test_a_verdict_with_no_criteria_still_asks_the_mechanical_ones() -> None:
    """Nothing declared, and the questions the service can answer are still asked."""
    result = evaluate((), observed())

    assert {r.criterion.name for r in result.results} == {
        c.name for c in MECHANICAL_CRITERIA
    }
