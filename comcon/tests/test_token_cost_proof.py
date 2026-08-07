"""The arithmetic of the token-cost proof, held to what it may claim.

The script needs a desktop, a model and somebody's money; its arithmetic needs
none of those. Three things decide what the artifact says — how tokens are summed
across a run, which runs may be counted as the price of the task, and which
banner the committed file carries — and all three are worth testing for the same
reason the deletion proof's banner is: the artifact is the deliverable, and a
sum that could be satisfied generously would make it a formality.

The summing test is the load-bearing one. The runner's own json output reports
the last model step rather than the run, and it understates in the direction that
flatters this project's claim. A fixture with three steps of different sizes is
the cheapest way to keep that bug from quietly coming back as a "simplification".
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]


def _load_prover() -> Any:
    """Loaded by path: `scripts/` holds hyphenated files meant to be run."""
    path = ROOT / "scripts" / "prove-token-cost.py"
    spec = importlib.util.spec_from_file_location("prove_token_cost", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prover = _load_prover()


def _usage(prompt: int, completion: int) -> dict:
    return {
        "type": "usage_update",
        "usage": {
            "promptTokens": prompt,
            "completionTokens": completion,
            "totalTokens": prompt + completion,
        },
    }


#: Three model steps of deliberately different sizes, so a sum and a last-step
#: read can never coincide by accident.
THREE_STEPS = [
    {"type": "thread_created", "threadId": "th-1"},
    _usage(1000, 50),
    {"type": "tool_start", "toolName": "desktop_list_windows"},
    _usage(1400, 80),
    {"type": "tool_start", "toolName": "desktop_invoke_element"},
    _usage(1800, 20),
    {"type": "agent_end", "reason": "complete"},
]


def _reduced(events: list[dict], exit_code: int = 0, wall_ms: int = 4200) -> dict:
    return prover.reduce_run(events, exit_code=exit_code, wall_ms=wall_ms)


def test_tokens_are_summed_across_steps_not_taken_from_the_last_one() -> None:
    run = _reduced(THREE_STEPS)

    assert run["inputTokens"] == 4200
    assert run["outputTokens"] == 150
    assert run["totalTokens"] == 4350

    # The number the runner's own `--output json` block would have reported. It is
    # kept so the artifact can print both, and it must not be the headline.
    assert run["lastStep"]["totalTokens"] == 1820
    assert run["totalTokens"] > run["lastStep"]["totalTokens"]


def test_a_round_trip_is_counted_per_model_step() -> None:
    assert _reduced(THREE_STEPS)["roundTrips"] == 3


def test_the_tools_a_run_reached_for_are_tallied() -> None:
    run = _reduced(THREE_STEPS)
    assert run["tools"] == {"desktop_list_windows": 1, "desktop_invoke_element": 1}
    assert run["offLane"] == []


def test_a_run_that_used_the_shell_is_not_counted() -> None:
    events = THREE_STEPS + [{"type": "tool_start", "toolName": "execute_command"}]
    run = _reduced(events)
    run["outcome"] = True

    assert run["offLane"] == ["execute_command"]
    assert not prover.usable(run), "a run that went around the lane is not its price"


def test_a_run_that_did_not_turn_the_setting_on_is_not_counted() -> None:
    run = _reduced(THREE_STEPS)
    run["outcome"] = False
    assert not prover.usable(run), "a failed run billed as the cost would understate it"


def test_a_run_with_no_reported_usage_is_unmeasured_rather_than_free() -> None:
    run = _reduced([{"type": "agent_end", "reason": "complete"}])
    run["outcome"] = True

    assert run["totalTokens"] == 0
    assert not prover.usable(run), "zero tokens must never read as a free run"


def test_a_nonzero_exit_is_not_counted_even_if_the_setting_ended_up_on() -> None:
    run = _reduced(THREE_STEPS, exit_code=2)
    run["outcome"] = True
    assert not prover.usable(run)


def _counted_run() -> dict:
    run = _reduced(THREE_STEPS)
    run["outcome"] = True
    return run


def test_a_measured_run_without_a_comparison_is_partial_never_a_pass() -> None:
    banner, code = prover.verdict([_counted_run()], comparison_ran=False)

    assert code == prover.EXIT_PARTIAL
    assert "COMPARISON WAS NOT RUN" in banner
    assert "CLAIM HOLDS" not in banner


def test_the_claim_holds_only_when_both_legs_ran() -> None:
    banner, code = prover.verdict([_counted_run()], comparison_ran=True)
    assert code == prover.EXIT_OK
    assert banner == "THE CLAIM HOLDS"


def test_no_runs_at_all_is_nothing_measured_rather_than_a_refutation() -> None:
    banner, code = prover.verdict([], comparison_ran=False)

    assert code == prover.EXIT_PARTIAL
    assert "NOTHING WAS MEASURED" in banner


def test_runs_that_all_failed_the_task_are_a_refutation_not_a_gap() -> None:
    failed = _reduced(THREE_STEPS)
    failed["outcome"] = False

    banner, code = prover.verdict([failed], comparison_ran=False)
    assert code == prover.EXIT_CLAIM_UNMET
    assert "NOT COMPLETED" in banner


def test_the_median_ignores_runs_that_were_not_counted() -> None:
    cheap_but_failed = _reduced(
        [{"type": "thread_created", "threadId": "t"}, _usage(1, 1)]
    )
    cheap_but_failed["outcome"] = False

    runs = [_counted_run(), cheap_but_failed]

    assert prover.median_of(runs, "totalTokens") == 4350


def test_the_refusals_quoted_are_the_ones_a_screenshot_agent_would_need() -> None:
    report = {
        "tiers": [
            {"id": "accessibility", "available": True, "reason": None},
            {
                "id": "vision",
                "available": True,
                "reason": None,
                "detail": {
                    "windowCapture": True,
                    "screenCapture": False,
                    "screenCaptureReason": "out of scope by design",
                    "ocr": False,
                    "ocrReason": "deferred by scope",
                },
            },
            {"id": "raw-input", "available": False, "reason": "out of scope by design"},
        ]
    }

    rows = prover.refusals(report)
    quoted = {(tier, capability) for tier, capability, _reason in rows}

    # The vision tier is "available" because window capture works, so a check that
    # only read the tier flag would quote nothing and the artifact would assert a
    # refusal it never showed.
    assert ("vision", "screenCapture") in quoted
    assert ("vision", "ocr") in quoted
    assert ("raw-input", "") in quoted
    assert all(reason for _tier, _capability, reason in rows)


def test_a_run_that_measured_nothing_writes_no_artifact() -> None:
    """The proofs directory is read as evidence, so an empty file is a claim.

    Asserted against the source because the behaviour lives in `main`, which
    needs a desktop to reach; the guard that matters is that the early return
    happens before anything is written.
    """
    source = (ROOT / "scripts" / "prove-token-cost.py").read_text()
    body = source.split("def main(")[1]

    guard = body.index("if not runs:")
    write = body.index("out.write_text(")
    assert guard < write, "the no-runs return must come before the artifact is written"


def test_no_comparison_number_is_hard_coded_anywhere_in_the_script() -> None:
    """The one thing the issue forbids outright is an invented comparison.

    Guarded by reading the script rather than by review, because the tempting
    edit — "roughly 10x cheaper" in a summary line — would look harmless in a
    diff and would be the only unverifiable number in the artifact.
    """
    source = (ROOT / "scripts" / "prove-token-cost.py").read_text()

    for tempting in ("x cheaper", "× cheaper", "times cheaper", "roughly ", "approximately "):
        assert tempting not in source.lower(), f"the script must not claim {tempting!r}"
