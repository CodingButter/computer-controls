#!/usr/bin/env python3
"""Measures what one canonical task costs when it is driven by meaning.

The README claims that operating a desktop semantically is cheaper than driving
it by screenshots and coordinates. That claim has never been measured here, and
an unmeasured claim is a sales pitch. This script measures the half of it that
this machine can honestly measure: the canonical task — open the text editor's
preferences and turn on line numbers — run through the desktop-control plugin,
recorded in tokens, model round trips and wall time.

The other half is not measured, and not estimated. Screenshot-and-coordinate
control needs an OCR engine and a raw input driver, and this build refuses both
by design rather than by accident. The artifact quotes that refusal verbatim and
says plainly that no comparison run was performed. An invented number here would
be the most useful number in the document and the only one nobody could check,
which is exactly why it is not written.

Two measurement details are load-bearing:

* Tokens are summed from the `usage_update` events of `--output jsonl`, never
  read from the `--output json` block. The runner's `aggregate()` assigns
  `acc.usage` on every `usage_update` rather than accumulating, so the json block
  reports the *last step* of a multi-step run. Both figures are printed so the
  gap is visible rather than argued about.
* Success is read from `gsettings`, out of band, because the outcome of this
  particular task is invisible to the accessibility tree: toggling line numbers
  on GTK4 changes the screen and produces no accessible node. A run that failed
  must never be billed as the task's price.

Usage: python3 scripts/prove-token-cost.py [--runs 3] [--out docs/proofs/<name>.md]
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "comcon"))

from desktop_service import capabilities  # noqa: E402
from desktop_service.backends import atspi, capture, loop, session_env  # noqa: E402

DEFAULT_OUT = "docs/proofs/what-one-semantic-task-costs.md"
APPLICATION = "gnome-text-editor"
SETTING = ("org.gnome.TextEditor", "show-line-numbers")

#: The task, worded as a person would ask for it and pinned to the semantic lane.
#: The constraint is part of the measurement: a run that reached for the shell
#: would be cheap for reasons that have nothing to do with the claim.
TASK = (
    "Using the desktop control tools, open the text editor's preferences and turn "
    "on line numbers. Use only the desktop tools: do not use the shell, do not edit "
    "files, and do not change the setting any other way."
)

#: Tools that would accomplish the task by going around the thing being measured.
#: A run that used one is reported with its numbers and excluded from the median.
OFF_LANE_TOOLS = frozenset(
    {"execute_command", "write_file", "string_replace_lsp", "ast_smart_edit", "shell"}
)

#: Exit codes the operator is asked to tell apart. A machine that is merely
#: misconfigured (no runner, no plugin) has not measured anything and has not
#: found anything either; a desktop that could not be reached is the parked case
#: the other live proofs already have a shape for.
EXIT_OK = 0
EXIT_CLAIM_UNMET = 1
EXIT_MISCONFIGURED = 3
EXIT_PARTIAL = 4


def reduce_run(events: list[dict], *, exit_code: int, wall_ms: int) -> dict:
    """Folds one run's jsonl events into the numbers the artifact reports.

    Pure, and separated from the subprocess for the same reason the deletion
    proof's banner is: the arithmetic is the deliverable, and arithmetic that
    only runs on a desktop is arithmetic nobody re-checks.

    `total_tokens` is summed across steps; `last_step` is what `--output json`
    would have reported for the same run. They are both kept because the second
    is the number a reader would otherwise have trusted.
    """
    input_tokens = output_tokens = total_tokens = 0
    round_trips = 0
    last_step: dict[str, int] = {}
    tools: dict[str, int] = {}
    finish_reason = ""
    thread_id = ""
    error = ""

    for event in events:
        kind = event.get("type")
        if kind == "usage_update":
            usage = event.get("usage") or {}
            prompt = int(usage.get("promptTokens") or 0)
            completion = int(usage.get("completionTokens") or 0)
            total = int(usage.get("totalTokens") or (prompt + completion))
            input_tokens += prompt
            output_tokens += completion
            total_tokens += total
            round_trips += 1
            last_step = {
                "inputTokens": prompt,
                "outputTokens": completion,
                "totalTokens": total,
            }
        elif kind == "tool_start":
            name = event.get("toolName") or ""
            tools[name] = tools.get(name, 0) + 1
        elif kind == "agent_end":
            finish_reason = event.get("reason") or ""
        elif kind in ("thread_created", "thread_changed"):
            thread_id = event.get("threadId") or thread_id
        elif kind == "error":
            error = (event.get("error") or {}).get("message") or "error"

    return {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": total_tokens,
        "roundTrips": round_trips,
        "lastStep": last_step,
        "tools": tools,
        "offLane": sorted(set(tools) & OFF_LANE_TOOLS),
        "finishReason": finish_reason,
        "threadId": thread_id,
        "error": error,
        "exitCode": exit_code,
        "wallMs": wall_ms,
    }


def usable(run: dict) -> bool:
    """Whether a run may be counted as the price of the task.

    Three ways to be excluded, each of which would flatter the number: the task
    did not actually get done, it got done through a tool that is not the thing
    being measured, or the provider reported no usage at all. The last is not
    free — it is unmeasured, and a zero in a token column would read as free.
    """
    return (
        bool(run.get("outcome"))
        and run["exitCode"] == 0
        and not run["offLane"]
        and run["roundTrips"] > 0
    )


def verdict(runs: list[dict], comparison_ran: bool) -> tuple[str, int]:
    """The banner the committed artifact carries, and the exit code beside it.

    A measured semantic cost with no comparison is a partial proof, not a
    refutation and not a pass: the claim is comparative, and half of a comparison
    does not settle it. Reporting that as success would be a lie with a filename.
    """
    counted = [run for run in runs if usable(run)]
    if not runs:
        return ("NOTHING WAS MEASURED — no run was attempted", EXIT_PARTIAL)
    if not counted:
        return (
            "THE TASK WAS NOT COMPLETED — no run finished it through the semantic lane",
            EXIT_CLAIM_UNMET,
        )
    if not comparison_ran:
        return (
            "THE SEMANTIC COST IS MEASURED; THE COMPARISON WAS NOT RUN ON THIS MACHINE",
            EXIT_PARTIAL,
        )
    return ("THE CLAIM HOLDS", EXIT_OK)


def median_of(runs: list[dict], key: str) -> int:
    counted = [run[key] for run in runs if usable(run)]
    return int(statistics.median(counted)) if counted else 0


def command(*argv: str) -> str:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return ""


def environment(runner: str, model: str) -> dict[str, str]:
    """What this measurement is true of.

    Discovered rather than read from this process's environment: a script run
    from an SSH shell inherits a terminal's idea of the session and would stamp
    the artifact "tty" while measuring GNOME.
    """
    borrowed = session_env.discover()
    return {
        "Measured": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "Operating system": command("lsb_release", "-ds") or platform.platform(),
        "Kernel": platform.release(),
        "Desktop environment": borrowed.get("XDG_CURRENT_DESKTOP") or "none discovered",
        "Session type": borrowed.get("XDG_SESSION_TYPE") or "none discovered",
        "Runner": f"`{runner}` {command(runner, '--version') or 'version unknown'}",
        "Model": f"`{model}`" if model else "runner default (not overridden)",
        "Node": command("node", "--version"),
        "Application": f"`{APPLICATION}`",
    }


def read_setting() -> bool | None:
    """The oracle, read out of band. None means the setting could not be read."""
    schema, key = SETTING
    out = command("gsettings", "get", schema, key)
    if out not in ("true", "false"):
        return None
    return out == "true"


def set_setting(value: bool) -> None:
    schema, key = SETTING
    subprocess.run(
        ["gsettings", "set", schema, key, "true" if value else "false"],
        capture_output=True,
        timeout=10,
    )


def one_run(runner: str, model: str, index: int, timeout: float) -> dict:
    """Drives the task once, on a fresh thread, and times it from out here.

    Wall time is measured around the child because the runner does not report it
    in any output mode, and a duration reconstructed from log timestamps would be
    measuring the log.
    """
    argv = [
        runner,
        "--output", "jsonl",
        "--permission-mode", "auto",
        "--thinking-level", "off",
        "--timeout", str(int(timeout)),
        "--title", f"P5 token cost run {index}",
        "--prompt", TASK,
    ]
    if model:
        argv[1:1] = ["--model", model]

    started = time.monotonic()
    completed = subprocess.run(
        argv, capture_output=True, text=True, timeout=timeout + 60, cwd=str(ROOT)
    )
    wall_ms = int((time.monotonic() - started) * 1000)

    events = []
    for line in completed.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    run = reduce_run(events, exit_code=completed.returncode, wall_ms=wall_ms)
    if not events and completed.stderr:
        run["error"] = run["error"] or completed.stderr.strip().splitlines()[-1][:200]
    return run


def capability_report() -> dict[str, Any] | None:
    """The live report, asked of the same backend the service asks."""
    loop.get_loop().start()
    try:
        return loop.call_on_loop(
            lambda: capabilities.build_report(
                probe_accessibility=atspi.probe_desktop,
                probe_capture=capture.unavailable_reason,
                session_token="prove-token-cost",
                observation_mode="poll",
                discover_session=session_env.discover,
            ),
            timeout=30.0,
        )
    except Exception:
        return None
    finally:
        loop.get_loop().stop()


def refusals(report: dict[str, Any] | None) -> list[tuple[str, str, str]]:
    """The build's own words for why the comparison leg cannot run here."""
    if not report:
        return []
    rows = []
    for tier in report.get("tiers", []):
        if tier["id"] not in ("vision", "raw-input"):
            continue
        if not tier.get("available") and tier.get("reason"):
            rows.append((tier["id"], "", tier["reason"]))
        # The vision tier reports its refusals one level down: the tier can be
        # "available" because window capture works while the two capabilities a
        # screenshot-driven agent would actually need are both off.
        detail = tier.get("detail") or {}
        for capability in ("screenCapture", "ocr"):
            if not detail.get(capability) and detail.get(f"{capability}Reason"):
                rows.append((tier["id"], capability, detail[f"{capability}Reason"]))
    return rows


def render(
    runs: list[dict],
    env: dict[str, str],
    banner: str,
    refusal_rows: list[tuple[str, str, str]],
) -> str:
    counted = [run for run in runs if usable(run)]

    lines = [
        "# Proof: what one semantic task costs",
        "",
        "Generated by `scripts/prove-token-cost.py`. Not hand-written, and not",
        "reachable by a unit test: the number is a property of a real model driving a",
        "real desktop, and the only way to know it is to spend it.",
        "",
        f"**Verdict: {banner}**",
        "",
        "## Environment",
        "",
        "| | |",
        "|---|---|",
    ]
    lines += [f"| {name} | {value} |" for name, value in env.items()]

    lines += [
        "",
        "## The task",
        "",
        "The canonical one, worded as a person would ask for it and pinned to the lane",
        "under measurement:",
        "",
        f"> {TASK}",
        "",
        "Each run starts a fresh thread. A resumed thread would carry the previous",
        "run's transcript into its input tokens and make the second run look cheaper",
        "than the first for a reason that has nothing to do with the desktop.",
        "",
        "## What each run cost",
        "",
        "| Run | Input | Output | Total | Round trips | Wall | Line numbers on | Counted |",
        "|---|---|---|---|---|---|---|---|",
    ]
    if runs:
        for index, run in enumerate(runs, start=1):
            outcome = run.get("outcome")
            lines.append(
                f"| {index} | {run['inputTokens']} | {run['outputTokens']} | "
                f"{run['totalTokens']} | {run['roundTrips']} | {run['wallMs']} ms | "
                f"{'yes' if outcome else 'NO'} | {'yes' if usable(run) else 'no'} |"
            )
    else:
        lines.append("| — | — | — | — | — | — | — | — |")

    if counted:
        lines += [
            "",
            f"Median of the {len(counted)} counted run(s): "
            f"**{median_of(runs, 'totalTokens')} tokens**, "
            f"**{median_of(runs, 'roundTrips')} model round trips**, "
            f"**{median_of(runs, 'wallMs')} ms**.",
        ]

    excluded = [run for run in runs if not usable(run)]
    if excluded:
        lines += [
            "",
            "### Runs that were measured but not counted",
            "",
            "Printed with their numbers rather than dropped, because a run that vanishes",
            "from an artifact is a run the reader cannot audit. None of them is billed as",
            "the price of the task: a run that did not finish it, or finished it through a",
            "tool that is not the thing being measured, would understate the cost.",
            "",
        ]
        for index, run in enumerate(runs, start=1):
            if usable(run):
                continue
            why = []
            if not run.get("outcome"):
                why.append("the setting did not end up on")
            if run["offLane"]:
                why.append(f"used off-lane tools: {', '.join(run['offLane'])}")
            if run["roundTrips"] == 0:
                why.append("the provider reported no usage — unmeasured, not free")
            if run["exitCode"] != 0:
                why.append(f"runner exit {run['exitCode']}")
            if run["error"]:
                why.append(f"error: {run['error']}")
            lines.append(f"- Run {index}: {'; '.join(why)}")

    lines += [
        "",
        "## Tools each run reached for",
        "",
    ]
    if any(run["tools"] for run in runs):
        for index, run in enumerate(runs, start=1):
            tally = ", ".join(f"`{name}` ×{count}" for name, count in sorted(run["tools"].items()))
            lines.append(f"- Run {index}: {tally or 'none'}")
    else:
        lines.append("No tool calls were recorded.")

    lines += [
        "",
        "## How the tokens were counted",
        "",
        "Summed from the `usage_update` events of `--output jsonl`, one per model step.",
        "",
        "This is not the obvious way, and the obvious way is wrong. The runner's",
        "`--output json` block carries a `usage` object that looks like the total for the",
        "run; it is the *last step only*, because the aggregator assigns `acc.usage` on",
        "each `usage_update` instead of accumulating it. On a multi-step task that is a",
        "large understatement, and it understates in the direction that flatters this",
        "very claim — which is why the run-by-run figures below are printed beside the",
        "sums above rather than left implicit.",
        "",
        "| Run | Summed across steps | What `--output json` would have said |",
        "|---|---|---|",
    ]
    if runs:
        for index, run in enumerate(runs, start=1):
            last = run["lastStep"].get("totalTokens", 0) if run["lastStep"] else 0
            lines.append(f"| {index} | {run['totalTokens']} | {last} |")
    else:
        lines.append("| — | — | — |")

    lines += [
        "",
        "## How success was checked",
        "",
        f"By reading `{SETTING[0]} {SETTING[1]}` before and after each run, out of band.",
        "",
        "Not by the accessibility tree, and this is the interesting part: turning line",
        "numbers on changes the screen and produces no accessibility change at all. The",
        "tree has no gutter node to find, so an agent driving by meaning alone cannot",
        "confirm this particular action from the tree — see `docs/07-open-questions.md`.",
        "The proof therefore asks a source outside the lane it is measuring, which is",
        "also the honest way round: an oracle supplied by the system under test would be",
        "grading its own homework.",
        "",
        "## The comparison that was not run",
        "",
        "**No screenshot-and-coordinate run was performed on this machine, and no",
        "comparison number is reported.**",
        "",
        "Not an oversight. Driving a desktop by screenshots and coordinates needs pixels",
        "to read and a way to click at a point, and this build refuses both — not for",
        "lack of a package, but by design. Its own capability report says so:",
        "",
    ]
    if refusal_rows:
        for tier, detail, reason in refusal_rows:
            label = f"`{tier}`" + (f" / `{detail}`" if detail else "")
            lines += [f"- {label}: {reason}", ""]
    else:
        lines += [
            "The capability report could not be read on this run, so the refusals cannot",
            "be quoted here. That is a gap in this artifact and is left visible as one.",
            "",
        ]

    lines += [
        "A comparison leg would need an OCR engine and a general raw-input driver added",
        "to a build whose governing rule is a semantic desktop, never a remote shell. The",
        "measurement is therefore possible, but not on this build and not without",
        "building the thing the project exists to avoid.",
        "",
        "What would settle it is a run of the same task on the same machine through a",
        "screenshot-driven agent, counted the same way. Until somebody does that, the",
        "number above is the cost of the semantic lane and nothing more: it is not a",
        "ratio, and this document does not compute one.",
        "",
        "## What this does not say",
        "",
        "One task, one model, one desktop, one moment. Token costs move with the model",
        "and with the tool descriptions in the system prompt — the active plugin set is",
        "stamped above because those descriptions are part of the input tokens, and a",
        "machine with more plugins loaded would measure a larger number for the same",
        "work.",
        "",
        "It says nothing about reliability. Counted runs are the ones that worked, so a",
        "median here is the price of success, not the expected price of asking.",
        "",
        "And it is not a comparison. The claim in the README is comparative; this",
        "artifact measures one side of it and says so in its verdict, because a",
        "half-measured comparison reported as a pass would be worth less than no",
        "artifact at all.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--model", default="", help="passed through to the runner")
    parser.add_argument("--timeout", type=float, default=300.0)
    args = parser.parse_args()

    runner = next(
        (name for name in ("mcdf", "mastracode") if shutil.which(name)),
        "",
    )
    if not runner:
        print(
            "no runner found on PATH (looked for `mcdf`, then `mastracode`). This proof "
            "measures what the agent runner spends, so there is nothing to measure "
            "without one. Nothing was written.",
            file=sys.stderr,
        )
        return EXIT_MISCONFIGURED

    registry = ROOT / ".mastracode" / "plugins" / "plugins.json"
    if not registry.exists():
        print(
            f"the plugin registry {registry} does not exist, so the runner would drive "
            "this task without the desktop tools and measure the wrong thing. The "
            "registry is git-ignored; see the README's registration snippet. "
            "Nothing was written.",
            file=sys.stderr,
        )
        return EXIT_MISCONFIGURED

    report = capability_report()
    accessibility = next(
        (tier for tier in (report or {}).get("tiers", []) if tier["id"] == "accessibility"),
        None,
    )
    desktop_reachable = bool(accessibility and accessibility.get("available"))

    runs: list[dict] = []
    if not desktop_reachable:
        print(
            "no desktop session is reachable from here, so the task cannot be driven "
            "and no cost can be measured. Recording the gap rather than a number.",
            file=sys.stderr,
        )
    else:
        for index in range(1, args.runs + 1):
            set_setting(False)
            before = read_setting()
            if before is not False:
                print(f"run {index}: could not reset the setting; skipping", file=sys.stderr)
                continue
            run = one_run(runner, args.model, index, args.timeout)
            run["outcome"] = read_setting() is True
            runs.append(run)
            print(
                f"run {index}: {run['totalTokens']} tokens, {run['roundTrips']} round "
                f"trips, {run['wallMs']} ms, line numbers "
                f"{'on' if run['outcome'] else 'NOT on'}"
            )

    banner, code = verdict(runs, comparison_ran=False)

    if not runs:
        # Deliberately no file. An artifact whose every cell is a dash would sit
        # in the proofs directory looking like a finding about the claim, when
        # all it records is that this machine had no desktop — which is a fact
        # about the machine. The deletion and browser proofs are parked for the
        # same reason rather than deposited empty.
        print(banner, file=sys.stderr)
        print(
            "Nothing was written: an artifact for a run that did not happen is worse "
            "than no artifact, because the directory is read as evidence. Re-run this "
            "on a machine with a logged-in desktop session.",
            file=sys.stderr,
        )
        return code

    env = environment(runner, args.model)
    env["Plugin registry"] = f"`{registry.relative_to(ROOT)}`"

    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(runs, env, banner, refusals(report)))
    print(f"\nWrote {out.relative_to(ROOT)}")
    print(banner)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
