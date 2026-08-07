#!/usr/bin/env python3
"""Watch a human delete text, and record what the service said about it.

The claim being proved is narrow and was previously unproven: that a person removing
characters from a live window is reported to a client as a *removal*, with a count, and
attributed to nobody. An earlier passive watch captured four value-change pulses from
real editing and described all four identically — "an element's value changed" — which
is a sentence an agent cannot act on. It cannot tell whether to re-read the field, and
it cannot tell whether it was itself responsible.

This script does not edit anything. It finds a text element, primes the watch, and then
waits for a human. Everything it records comes back through `getDeltaSince`, the same
call the plugin polls on a one-second tick, so what lands in the artifact is what a
client would actually have received.

The insertion that precedes the deletion is captured too, deliberately. A proof that
only shows a deletion being called a deletion leaves open the possibility that
everything is called a deletion; the pair is what shows the service telling them apart.

Usage:
    python3 scripts/prove-deletion-live.py
    python3 scripts/prove-deletion-live.py --application gedit --timeout 300
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "comcon"))

from desktop_service import server  # noqa: E402
from desktop_service.backends import atspi, loop, session_env, x11  # noqa: E402

DEFAULT_OUT = "docs/proofs/deletion-is-reported-as-deletion.md"
DEFAULT_APPLICATION = "gnome-text-editor"

#: The name this script subscribes under. In-process there is no transport to mint an
#: identity, so the subscription would be dropped on the floor without one.
CLIENT_ID = "prove-deletion-live"

#: Exit codes the operator is asked to tell apart. A run that measured nothing — no
#: window, no reachable field, nobody typing — has found nothing; a run that watched
#: edits arrive and never saw one called a deletion has found something, and the
#: instruction not to re-run applies only to the second. Collapsing them into one code
#: would make an unattended window look like a refutation.
EXIT_OK = 0
EXIT_CLAIM_UNMET = 1
EXIT_NOTHING_OBSERVED = 4

#: The cadence the plugin's desktop signal provider polls at. Proving this at a faster
#: tick would prove something no deployed client does.
POLL_SECONDS = 1.0
MAX_LEGAL_DEPTH = 12

#: Watching a password field would produce a run that never reports anything and never
#: says why: its value is redacted before it leaves the service, so it reads back the
#: same before and after the deletion, and no diff exists to find. Better to keep looking
#: than to sit through the timeout at a field that cannot answer.
SEARCH_ROLES = atspi.TEXT_VALUE_ROLES - {"password text"}


def environment() -> dict[str, str]:
    """What this measurement is true of.

    Discovered rather than read from this process's environment, for the same reason the
    compatibility matrix discovers it: run from an SSH shell, the terminal's idea of the
    session would stamp the artifact `tty` while it measured a GNOME desktop.
    """

    def command(*argv: str) -> str:
        try:
            return subprocess.run(argv, capture_output=True, text=True, timeout=5).stdout.strip()
        except Exception:
            return ""

    borrowed = session_env.discover()
    return {
        "Measured": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "Operating system": command("lsb_release", "-ds") or platform.platform(),
        "Desktop environment": borrowed.get("XDG_CURRENT_DESKTOP")
        or os.environ.get("XDG_CURRENT_DESKTOP", "unknown"),
        "Session type": borrowed.get("XDG_SESSION_TYPE")
        or os.environ.get("XDG_SESSION_TYPE", "unknown"),
        "Display": x11.attached_display() or os.environ.get("DISPLAY", "none"),
        "Python": platform.python_version(),
    }


def _walk(node, depth=0):
    yield node, depth
    for child in node.get("children") or ():
        yield from _walk(child, depth + 1)


def find_text_element(window_id: str) -> str | None:
    """The window's text buffer, reached through the handlers a client would use.

    Through `_method_inspect_*` rather than a private walk because only a handler records
    what it saw in the registry, and an element the registry has never heard of is not
    among the recent few the service re-samples. Inspecting privately would prime nothing
    and the watch would stay empty.

    The drill is not optional: a GTK4 editor puts its buffer below the deepest legal
    window inspection, so the frontier has to be anchored on.
    """
    tree = server._method_inspect_window(
        {"windowId": window_id, "depth": MAX_LEGAL_DEPTH, "maxNodes": 1000}
    )
    nodes = list(_walk(tree["window"]))
    for node, _depth in nodes:
        if node["role"] in SEARCH_ROLES:
            return node["id"]

    deepest = max(depth for _node, depth in nodes)
    for node, depth in nodes:
        if depth != deepest:
            continue
        try:
            drilled = server._method_inspect_element(
                {"elementId": node["id"], "depth": MAX_LEGAL_DEPTH, "maxNodes": 300}
            )
        except Exception:
            continue
        for below, _below_depth in _walk(drilled["element"]):
            if below["role"] in SEARCH_ROLES:
                return below["id"]
    return None


def acceptance(record: dict) -> list[tuple[str, bool, str]]:
    """The conditions the issue asked for, each answered separately.

    Separately on purpose. A single pass/fail would let a record that got the shape right
    and the attribution wrong read as a success, and attribution is half the claim: an
    agent that is told it caused a human's deletion will try to undo its own work.
    """
    detail = record.get("detail") or {}
    removed = detail.get("charactersRemoved", 0)
    return [
        (
            "reported as a deletion, not a generic change",
            detail.get("shape") == "deleted",
            f"shape: {detail.get('shape')!r}",
        ),
        (
            "carries the number of characters lost",
            isinstance(removed, int) and removed > 0,
            f"charactersRemoved: {removed}",
        ),
        (
            "a partial removal, distinguished from a cleared field",
            detail.get("lengthAfter", 0) > 0,
            f"lengthBefore: {detail.get('lengthBefore')}, lengthAfter: {detail.get('lengthAfter')}",
        ),
        (
            "attributed to nobody in this session",
            record.get("attribution") == "external",
            f"attribution: {record.get('attribution')!r}",
        ),
        (
            "no action of this session claims it",
            "causedBy" not in detail,
            f"causedBy: {detail.get('causedBy', 'absent')}",
        ),
        (
            "describes itself in words a reader can use",
            bool(record.get("summary")),
            f"summary: {record.get('summary')!r}",
        ),
    ]


def verdict(deletion: dict | None, contrast: dict | None) -> str:
    """The banner, which has three possible answers rather than two.

    A run that watched a field nobody edited has not refuted anything, and saying
    "THE CLAIM DOES NOT HOLD" over an empty window would put a refutation in the
    directory that no measurement supports. It is only a refutation once edits
    arrived and none of them came back named a deletion.
    """
    if deletion is None:
        if contrast is None:
            return "not proved — nothing was observed"
        return "THE CLAIM DOES NOT HOLD"
    met = all(ok for _label, ok, _seen in acceptance(deletion))
    return "the claim holds" if met else "THE CLAIM DOES NOT HOLD"


def render(
    deletion: dict | None, contrast: dict | None, env: dict[str, str], element_id: str
) -> str:
    # The preamble is a claim like any other: an artifact from a run that recorded
    # nothing must not open by saying a person made the edit below it.
    if deletion is None and contrast is None:
        preamble = [
            "Generated by `scripts/prove-deletion-live.py`. Not hand-written. This run",
            "watched a live window through `getDeltaSince` — the call the plugin polls on a",
            "one-second tick — and no change to the watched element arrived before it timed",
            "out, so it is deposited as a record of an attempt rather than of a measurement.",
        ]
    else:
        preamble = [
            "Generated by `scripts/prove-deletion-live.py`. Not hand-written, and not",
            "re-creatable from a unit test: the edit below was made by a person in a live",
            "window while the service watched, and every record is quoted as it came back",
            "from `getDeltaSince` — the call the plugin polls on a one-second tick.",
        ]

    lines = [
        "# Proof: a deletion is reported as a deletion",
        "",
        *preamble,
        "",
        f"**Verdict: {verdict(deletion, contrast)}**",
        "",
        "## Environment",
        "",
        "| | |",
        "|---|---|",
    ]
    lines += [f"| {key} | {value} |" for key, value in env.items()]
    lines += [f"| Watched element | `{element_id}` |", ""]

    lines += [
        "## What was asked of the record",
        "",
        "| Condition | Met | Observed |",
        "|---|---|---|",
    ]
    if deletion is None:
        lines += [
            f"| {label} | — | `no deletion record was captured` |"
            for label, _ok, _seen in acceptance({})
        ]
    else:
        for label, ok, seen in acceptance(deletion):
            lines.append(f"| {label} | {'yes' if ok else 'NO'} | `{seen}` |")

    if deletion is not None:
        lines += [
            "",
            "## The deletion, as a client received it",
            "",
            "```json",
            json.dumps(deletion, indent=2, sort_keys=True),
            "```",
            "",
        ]
    elif contrast is not None:
        lines += [
            "",
            "## No deletion was reported, and edits were arriving",
            "",
            "The watch was live and the element was being changed — the record below came",
            "back during the wait — and the service still never described a change to it as",
            "a deletion before the timeout. That is a refutation rather than a missing",
            "measurement, and it is recorded as one.",
            "",
        ]
    else:
        lines += [
            "",
            "## Nothing was observed",
            "",
            "No change to the watched element reached this script before the timeout, so",
            "there is nothing here to judge the claim by. This is not evidence against the",
            "claim: an unattended window and a broken watch produce the same silence, and",
            "the run cannot tell them apart. Re-running is the right response to this",
            "artifact — the instruction not to re-run belongs to a run that saw edits and",
            "never saw a deletion among them.",
            "",
        ]

    if contrast is not None:
        contrast_shape = (contrast.get("detail") or {}).get("shape")
        heading = (
            "## The edit before it, for contrast"
            if deletion is not None
            else "## What the service did say about this element"
        )
        lines += [
            heading,
            "",
            "The same element, the same lane, the same poll. This is the half of the proof",
            "that a deletion record alone cannot supply: the service is not calling",
            f"everything a deletion, because it called this one `{contrast_shape}`.",
            "",
            "```json",
            json.dumps(contrast, indent=2, sort_keys=True),
            "```",
            "",
        ]
    elif deletion is not None:
        lines += [
            "## No contrasting edit was captured",
            "",
            "Nothing was recorded before the deletion, so this artifact shows a deletion",
            "being named correctly without showing that a different edit would be named",
            "differently. The unit tests in `comcon/tests/test_deltas.py` cover that",
            "distinction; this run did not, and saying so is cheaper than implying it did.",
            "",
        ]

    lines += [
        "## What this does not say",
        "",
        "One desktop, one toolkit, one moment. A record captured here is evidence that the",
        "shape reaches a client on this stack, not that every toolkit reports text the same",
        "way — the compatibility matrix is where that question lives.",
        "",
        "It also says nothing about latency. The deletion is found by polling, so the delay",
        "between the key press and the record is a property of the poll interval, not a",
        "measurement of the service.",
        "",
        "And it says nothing about what was typed. The records above are lengths, counts and",
        "an element reference — a value-change record carries no text by construction, which",
        "is what makes this artifact safe to commit after a person typed into a real editor.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--application", default=DEFAULT_APPLICATION)
    parser.add_argument("--timeout", type=float, default=180.0, help="seconds to wait for a human")
    args = parser.parse_args()

    loop.get_loop().start()
    try:
        windows = server._method_list_windows({})["windows"]
        window = next((w for w in windows if w["applicationName"] == args.application), None)
        if window is None:
            names = sorted({w["applicationName"] for w in windows})
            print(
                f"no window of {args.application!r} on the accessibility bus; "
                f"open one first. Present: {', '.join(names) or 'nothing'}",
                file=sys.stderr,
            )
            return EXIT_NOTHING_OBSERVED

        element_id = find_text_element(window["id"])
        if element_id is None:
            print(
                f"{args.application} has a window but no text element was reachable in it",
                file=sys.stderr,
            )
            return EXIT_NOTHING_OBSERVED

        # Say out loud that this element is the one being watched, rather than trusting
        # it to stay among the sixteen most recently seen. The recency set is a heuristic
        # for a session that inspects as it goes, and this run does the opposite: it
        # inspects once and then sits still for three minutes while a human works, which
        # is exactly the window in which anything else touching the desktop could push the
        # target out. Eviction would not raise anything — the polls would simply stay
        # quiet — so an unsubscribed run can report "no deletion" about a deletion that
        # happened. `clientId` is passed explicitly because in-process there is no
        # connection to mint one, and a subscription declared under an empty id is
        # silently dropped.
        server._method_subscribe_element({"elementId": element_id, "clientId": CLIENT_ID})

        # Priming before the prompt, not after: `diff` only reports an element it saw in
        # both snapshots, so a baseline taken after the human had already started would
        # make the first sight of their text an addition rather than a change.
        cursor = server._method_get_delta_since({"sinceRevision": 0})["revision"]

        print(f"watching {element_id} in {args.application} (revision {cursor})")
        print()
        print("  1. type a sentence into the window")
        print("  2. select part of it — not all of it — and delete it")
        print()
        print(f"waiting up to {args.timeout:.0f}s. Ctrl-C to give up.")

        deletion = None
        contrast = None
        deadline = time.monotonic() + args.timeout
        while deletion is None and time.monotonic() < deadline:
            time.sleep(POLL_SECONDS)
            delta = server._method_get_delta_since({"sinceRevision": cursor})
            cursor = delta["revision"]
            for change in delta["changes"]:
                if change["kind"] != "element-value-changed":
                    continue
                if change.get("elementId") != element_id:
                    continue
                shape = (change.get("detail") or {}).get("shape")
                print(f"  saw: {change.get('summary')} [{shape}]")
                if shape == "deleted":
                    deletion = change
                    break
                contrast = change
    except KeyboardInterrupt:
        print("\ngave up", file=sys.stderr)
        return EXIT_CLAIM_UNMET
    finally:
        loop.get_loop().stop()

    # Written before the verdict is announced, and written whatever the verdict is. A
    # timeout used to return here with nothing on disk, which threw away the most
    # expensive thing the run produced: a person's minute at a real keyboard. What that
    # minute bought — that the watch was live, what the service did say about the
    # element, and that it never said "deleted" — is exactly what a reader needs to tell
    # a broken watch from a broken claim.
    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(deletion, contrast, environment(), element_id))
    print(f"\n{out}: written")

    if deletion is None:
        if contrast is None:
            print(
                "no change to the watched element was reported before the timeout. Nothing "
                "was measured either way — if nobody typed, or the window was not the one "
                "being watched, run it again.",
                file=sys.stderr,
            )
            return EXIT_NOTHING_OBSERVED
        print(
            "changes to the watched element arrived and none was reported as a deletion. "
            "That is the finding — do not re-run until it passes.",
            file=sys.stderr,
        )
        return EXIT_CLAIM_UNMET

    failed = [label for label, ok, _seen in acceptance(deletion) if not ok]
    if failed:
        print("the record was captured but does not meet: " + "; ".join(failed), file=sys.stderr)
        return EXIT_CLAIM_UNMET
    print("every condition met")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
