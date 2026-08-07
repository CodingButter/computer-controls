"""Proof that the gate suite would notice if the gates stopped working.

A passing test suite is evidence about the tests, not about the code, until
somebody breaks the code and watches it fail. That is doubly true here: every
gate is a negative — it makes the keeper do *less* — so a gate that silently
stopped firing would produce no error, no exception and no failing assertion
anywhere. It would just quietly restore the fifteen-minute kickoff loop that
issue #210 is about, and the suite would stay green while it did.

So each gate is disabled in turn, at the source, and the suite is expected to
go red. A gate whose removal leaves the suite green is not protected by a test
and the PR must say so.

Both directions are mutated, because this keeper has two failure modes and only
one of them is loud. Under-gating replays kickoffs, which is annoying and
visible. Over-gating silently halts all issue work — the repository already
carries a commit named `stop the two faults that silently halted all issue
work` — and looks from the outside like nothing happening, which is also what a
quiet afternoon looks like. The mutations that make a gate refuse *too much*
are the ones guarding against that.

The harness patches the real file and restores it in a `finally`. It asserts
the patch actually changed the bytes before running anything, because a
substitution that silently matched nothing would run the suite against
untouched code and report a comfortable, meaningless pass.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
GATES = ROOT / "scripts" / "factory_keeper" / "gates.py"
SUITE = ROOT / "service" / "tests" / "test_factory_keeper.py"

#: Each entry disables one gate by rewriting its condition. The name is the gate
#: it removes; the pair is the exact source text and its replacement.
UNDER_GATING_MUTATIONS = {
    "G0-binding-revoked": ('if binding.status != "active":', "if False:"),
    "G0-row-expired": ("if age > MAX_ROW_AGE:", "if False:"),
    "G1-item-missing": ("if item is None:", "if False:"),
    "G1-terminal-stage": ("if stage in TERMINAL_STAGES:", "if False:"),
    "G2-issue-closed": (
        'if issue_state and issue_state.upper() == "CLOSED":',
        "if False:",
    ),
    "G3-payload-role-mismatch": (
        "if _skill_is_wrong_for_role(binding.role, dispatched):",
        "if False:",
    ),
    "G4-role-stage-mismatch": (
        "if _role_is_wrong_for_stage(binding.role, stage):",
        "if False:",
    ),
    "G6-thread-active": ("if idle_for < ACTIVITY_WINDOW:", "if False:"),
}

#: The opposite sin: gates that refuse things they should pass. These are the
#: silent-halt mutations, and the tests that catch them are the counter-examples
#: — the work-role binding carrying a plan payload, the unknown issue state, the
#: item sitting on two boards.
OVER_GATING_MUTATIONS = {
    "G3 stops failing open on an unmapped role": (
        "    if allowed is None or skill is None:\n        return False",
        "    if allowed is None or skill is None:\n        return True",
    ),
    "G4 stops failing open on an unmapped role": (
        "    allowed = ROLE_STAGES.get(role)\n    if allowed is None or stage is None:\n        return False",
        "    allowed = ROLE_STAGES.get(role)\n    if allowed is None or stage is None:\n        return True",
    ),
    "G2 treats an unknown issue state as closed": (
        'if issue_state and issue_state.upper() == "CLOSED":',
        'if not issue_state or issue_state.upper() == "CLOSED":',
    ),
}


def run_suite_against(mutated_source: str) -> subprocess.CompletedProcess:
    """Install a broken gates.py, run the gate suite, always put it back."""
    original = GATES.read_text()
    assert mutated_source != original, "mutation changed nothing"

    try:
        GATES.write_text(mutated_source)
        return subprocess.run(
            [
                sys.executable,
                "-m",
                "pytest",
                "-q",
                "--no-live",
                "-p",
                "no:cacheprovider",
                str(SUITE),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
    finally:
        GATES.write_text(original)
        assert GATES.read_text() == original, "gates.py was not restored"


def mutate(marker: str, replacement: str) -> str:
    """Apply one substitution, insisting that it matched exactly once.

    The count matters as much as the change. A marker that matched twice would
    disable a second gate as a side effect and the resulting red suite would be
    evidence about the wrong thing.
    """
    source = GATES.read_text()
    assert source.count(marker) == 1, (
        f"expected exactly one occurrence of {marker!r}, found {source.count(marker)} "
        "- the mutation harness is out of date with gates.py"
    )
    return source.replace(marker, replacement)


@pytest.mark.parametrize(
    ("gate", "marker", "replacement"),
    [(gate, marker, repl) for gate, (marker, repl) in UNDER_GATING_MUTATIONS.items()],
    ids=list(UNDER_GATING_MUTATIONS),
)
def test_removing_a_gate_turns_the_suite_red(
    gate: str, marker: str, replacement: str
) -> None:
    """Every gate is load-bearing: delete it and a test must notice."""
    result = run_suite_against(mutate(marker, replacement))

    assert result.returncode != 0, (
        f"disabling {gate} left the suite green - that gate is unprotected, "
        "and the PR must report it as a finding"
    )


@pytest.mark.parametrize(
    ("description", "marker", "replacement"),
    [(name, marker, repl) for name, (marker, repl) in OVER_GATING_MUTATIONS.items()],
    ids=list(OVER_GATING_MUTATIONS),
)
def test_over_gating_turns_the_suite_red(
    description: str, marker: str, replacement: str
) -> None:
    """The silent halt is caught too, not just the noisy replay."""
    result = run_suite_against(mutate(marker, replacement))

    assert result.returncode != 0, (
        f"{description} left the suite green - nothing would catch a keeper "
        "that quietly refuses to wake real work"
    )


def test_the_harness_notices_a_patch_that_did_not_apply() -> None:
    """The harness's own failure mode, asserted rather than assumed.

    A silently-failed substitution proves nothing while looking exactly like a
    successful proof, so `mutate` refuses text it cannot find. Without this,
    every test above could rot into a no-op the day a condition is reworded.
    """
    with pytest.raises(AssertionError):
        mutate("this text is not in gates.py", "irrelevant")


def test_gates_file_is_intact_after_the_mutation_suite() -> None:
    """Belt and braces: no mutation may outlive the test that installed it.

    Deliberately not `git diff` — gates.py is untracked on the branch that
    introduces it, and `git diff` reports nothing for an untracked file, so
    that check would have passed even against a file left full of `if False:`.
    Reading the content is the only version of this assertion that is true on
    the first commit as well as every one after it.
    """
    source = GATES.read_text()

    for marker, _ in UNDER_GATING_MUTATIONS.values():
        assert source.count(marker) == 1, f"gates.py left mutated: {marker!r} missing"
    assert "if False:" not in source, "a disabled gate survived the mutation suite"
