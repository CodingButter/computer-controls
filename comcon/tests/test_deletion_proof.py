"""The judgement of the live deletion proof, held to what it may claim.

The script itself needs a desktop and a person; its judgement does not. Six
conditions decide whether a captured record counts as "a deletion was reported as
a deletion", and one banner decides what the committed artifact says about the
run. Both are arithmetic over dictionaries, and both are worth testing for the
same reason the keystroke proof's table is: the artifact is the deliverable, and a
table that could be satisfied generously would make it a formality.

The banner is the part with teeth. A run that saw nothing and a run that saw edits
which were never called deletions are not the same finding, and the artifact must
not spend a refutation on silence — an unattended window and a broken watch look
identical from here.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]

ELEMENT = "el-9f2c1a4b7d80"

ENV = {"Measured": "2026-08-07 09:12 UTC", "Desktop environment": "GNOME"}


def _load_prover() -> Any:
    """Loaded by path: `scripts/` holds hyphenated files meant to be run."""
    path = ROOT / "scripts" / "prove-deletion-live.py"
    spec = importlib.util.spec_from_file_location("prove_deletion_live", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prover = _load_prover()


def deletion(**detail: Any) -> dict:
    """A record shaped like the one `getDeltaSince` returns for a human's deletion."""
    shape = {
        "shape": "deleted",
        "lengthBefore": 44,
        "lengthAfter": 38,
        "charactersAdded": 0,
        "charactersRemoved": 6,
        "unchangedPrefix": 4,
    }
    shape.update(detail)
    return {
        "kind": "element-value-changed",
        "revision": 12,
        "elementId": ELEMENT,
        "applicationName": "gnome-text-editor",
        "attribution": "external",
        "summary": "an element's value lost 6 characters",
        "detail": shape,
    }


def insertion() -> dict:
    """The contrasting edit: the same element, named something other than a deletion."""
    return {
        "kind": "element-value-changed",
        "revision": 11,
        "elementId": ELEMENT,
        "applicationName": "gnome-text-editor",
        "attribution": "external",
        "summary": "an element's value grew by 44 characters at the end",
        "detail": {
            "shape": "appended",
            "lengthBefore": 0,
            "lengthAfter": 44,
            "charactersAdded": 44,
            "charactersRemoved": 0,
            "unchangedPrefix": 0,
        },
    }


def unmet(record: dict) -> list[str]:
    return [label for label, ok, _seen in prover.acceptance(record) if not ok]


def test_a_human_deletion_meets_every_condition():
    """The record the run exists to capture, judged as a pass."""
    assert unmet(deletion()) == []


def test_a_generic_change_is_not_a_deletion():
    """The original complaint: four pulses that all said "the value changed"."""
    assert "reported as a deletion, not a generic change" in unmet(
        deletion(shape="replaced")
    )


def test_a_deletion_without_a_count_is_not_enough():
    """A shape with no number is a category, and a reader cannot act on a category."""
    assert "carries the number of characters lost" in unmet(deletion(charactersRemoved=0))


def test_a_cleared_field_does_not_pass_as_a_partial_removal():
    """The condition that stops the easy case standing in for the hard one.

    Wiping a field is the removal every toolkit reports; excising six characters
    from the middle of a sentence is the one this proof is about.
    """
    record = deletion(shape="cleared", lengthAfter=0, charactersRemoved=44)
    assert unmet(record) == [
        "reported as a deletion, not a generic change",
        "a partial removal, distinguished from a cleared field",
    ]


def test_a_deletion_the_session_is_blamed_for_fails():
    """Half the claim, and the half with consequences.

    An agent told it caused a human's deletion will try to undo its own work.
    """
    assert unmet({**deletion(), "attribution": "self"}) == [
        "attributed to nobody in this session"
    ]


def test_an_action_claiming_the_deletion_fails():
    """`causedBy` present means some action in this session owns the edit."""
    assert unmet(deletion(causedBy="act-3f19")) == ["no action of this session claims it"]


def test_a_record_with_no_summary_fails():
    assert unmet({**deletion(), "summary": ""}) == [
        "describes itself in words a reader can use"
    ]


def test_a_passing_run_says_the_claim_holds_and_shows_both_edits():
    artifact = prover.render(deletion(), insertion(), ENV, ELEMENT)

    assert "**Verdict: the claim holds**" in artifact
    assert "THE CLAIM DOES NOT HOLD" not in artifact
    assert "## The edit before it, for contrast" in artifact
    assert "`appended`" in artifact


def test_a_captured_deletion_that_fails_a_condition_does_not_read_as_a_pass():
    artifact = prover.render({**deletion(), "attribution": "self"}, insertion(), ENV, ELEMENT)

    assert "**Verdict: THE CLAIM DOES NOT HOLD**" in artifact
    assert "| attributed to nobody in this session | NO |" in artifact


def test_a_timeout_that_saw_edits_is_recorded_as_a_refutation():
    """Edits arrived, none was called a deletion. That is a finding, and it is kept."""
    artifact = prover.render(None, insertion(), ENV, ELEMENT)

    assert "**Verdict: THE CLAIM DOES NOT HOLD**" in artifact
    assert "## No deletion was reported, and edits were arriving" in artifact
    assert "no deletion record was captured" in artifact
    # The record that did arrive is the evidence the watch was alive, so it is quoted.
    assert '"shape": "appended"' in artifact


def test_a_timeout_that_saw_nothing_does_not_spend_a_refutation_on_silence():
    """The distinction the exit codes exist for, made in the artifact's own words."""
    artifact = prover.render(None, None, ENV, ELEMENT)

    assert "**Verdict: not proved — nothing was observed**" in artifact
    assert "THE CLAIM DOES NOT HOLD" not in artifact
    assert "## Nothing was observed" in artifact
    assert "Re-running is the right response" in artifact
    # And it must not open by describing an edit it never saw.
    assert "the edit below was made by a person" not in artifact


def test_every_artifact_names_the_element_and_the_environment_it_measured():
    """A proof that does not say what it is true of is a claim with a table in it."""
    for record, contrast in ((deletion(), insertion()), (None, None)):
        artifact = prover.render(record, contrast, ENV, ELEMENT)
        assert f"| Watched element | `{ELEMENT}` |" in artifact
        assert "| Measured | 2026-08-07 09:12 UTC |" in artifact


def test_the_script_subscribes_under_a_name_the_service_will_keep():
    """The eviction guard, checked where it can silently fail.

    A subscription declared under an empty client id is dropped without an error
    — which is what an in-process caller gets if it lets the handler infer its
    identity — and the run would then be back on the recency heuristic while
    believing it was not. Nothing would raise; the polls would just stay quiet
    through a deletion that happened.
    """
    from desktop_service import subscriptions

    try:
        subscriptions.declare("", ELEMENT)
        assert ELEMENT not in subscriptions.all_ids()

        subscriptions.declare(prover.CLIENT_ID, ELEMENT)
        assert ELEMENT in subscriptions.all_ids()
    finally:
        subscriptions.forget(prover.CLIENT_ID)


def test_the_three_exit_codes_are_distinct():
    """The operator is asked to tell these apart; they cannot collide."""
    codes = {prover.EXIT_OK, prover.EXIT_CLAIM_UNMET, prover.EXIT_NOTHING_OBSERVED}
    assert len(codes) == 3
    assert prover.EXIT_OK == 0
