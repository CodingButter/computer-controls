"""The condition table of the live keystroke proof, held to what it may pass.

The proof script is the only thing in this repository that can say the characters
reached the X server, and its verdict is a table of separate conditions rather
than one boolean precisely so that a run cannot pass by being summarised
generously. That makes the table itself worth testing: it decides what counts as
a proof, and it now has an exception in it.

The exception is a field that does not report its contents. Two of the seven
conditions ask what the field says afterwards, and a composer that answers with a
single embedded-object character can never satisfy either — not because the
characters did not land, but because nothing on this desktop can be asked. Those
two conditions are met on the narrower claim there, and the artifact says so in
words. The risk is obvious and is what these tests are for: an exception that
also swallowed a genuine mismatch would turn the table into a formality.

No desktop is needed. The script's judgement is arithmetic over the two result
dictionaries it was handed, which is the half that can be proved anywhere.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]

#: The composer's entire answer about its contents, empty or full. The exact
#: string the live run recorded against Discord, kept verbatim so this suite is
#: exercising the case the artifact is about.
OPAQUE = "\ufffc"

TEXT = "keystroke tier proof"


def _load_prover() -> Any:
    """Loaded by path: `scripts/` holds hyphenated files meant to be run."""
    path = ROOT / "scripts" / "prove-keystrokes-live.py"
    spec = importlib.util.spec_from_file_location("prove_keystrokes_live", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prover = _load_prover()


def refused() -> dict:
    """What `typeText` says about a field it has no interface to write through."""
    return {
        "ok": False,
        "raised": "ACTION_NOT_SUPPORTED",
        "message": "typeText was refused by every available tier (accessibility)",
    }


def keystroke_result(verified: str, *, typed: int = len(TEXT), ok: bool = True) -> dict:
    return {
        "ok": ok,
        "backend": "keystrokes",
        "progress": {
            "charactersPlanned": len(TEXT),
            "charactersTyped": typed,
            "focusedWindow": "79691786",
            "verified": verified,
        },
    }


def unmet(checks: list[tuple[str, bool, str]]) -> list[str]:
    return [label for label, ok, _seen in checks if not ok]


def test_an_opaque_field_meets_every_condition():
    """The run the issue is about: 20 of 20 typed into a field that will not say so.

    Every mechanical condition holds — the accessible write refused first, the
    keystroke tier accepted, the backend and window are named, every character
    was sent — and the two conditions about the field's contents are met on the
    narrower claim rather than dropped.
    """
    checks = prover.acceptance(refused(), keystroke_result("unverifiable"), TEXT, OPAQUE)

    assert unmet(checks) == []


def test_an_opaque_run_says_the_claim_holds_and_says_what_it_did_not_show():
    """A passing artifact that does not overstate itself.

    The banner and the caveat are one decision: a verdict of "the claim holds"
    against a field nobody could read is only honest while the paragraph
    explaining the gap is sitting underneath it.
    """
    artifact = prover.render(
        refused(),
        keystroke_result("unverifiable"),
        OPAQUE,
        TEXT,
        {"Measured": "2026-08-04 09:55 UTC"},
        "el-e26757892f6d",
        "Discord",
    )

    assert "**Verdict: the claim holds**" in artifact
    assert "THE CLAIM DOES NOT HOLD" not in artifact
    assert "does not show the characters sitting in the field" in artifact
    assert "the field is opaque" in artifact


def test_a_genuine_mismatch_still_fails_the_table():
    """The condition the exception must not swallow.

    This field answered, and answered with something other than what was typed.
    Both content conditions have to fail, or the table has stopped being a test.
    """
    checks = prover.acceptance(
        refused(), keystroke_result("mismatch", ok=False), TEXT, "keystro"
    )

    assert unmet(checks) == [
        "the keystroke tier accepted it",
        "the service reached a verdict about the field",
        "the field really holds the text, read back independently of that verdict",
    ]


def test_an_unverifiable_verdict_is_not_a_pass_where_the_accessible_write_worked():
    """The escalation has to have been warranted for its verdict to count.

    A field `typeText` could write to has no business being typed at by
    keystrokes, and an unverifiable verdict against one is not evidence of an
    opaque composer — it is evidence that this script proved the wrong thing.
    """
    accepted = {"ok": True, "progress": {}}
    checks = prover.acceptance(accepted, keystroke_result("unverifiable"), TEXT, OPAQUE)

    assert unmet(checks) == [
        "the accessible write refused this field first",
        "the service reached a verdict about the field",
        "the field really holds the text, read back independently of that verdict",
    ]


def test_a_field_that_reads_back_is_still_judged_the_old_way():
    """The ordinary case, unchanged: the text is there and the artifact shows it."""
    checks = prover.acceptance(
        refused(), keystroke_result("verified"), TEXT, f"before: {TEXT}"
    )

    assert unmet(checks) == []
    observed = dict((label, seen) for label, _ok, seen in checks)
    assert "opaque" not in observed[
        "the field really holds the text, read back independently of that verdict"
    ]
