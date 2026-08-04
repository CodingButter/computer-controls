#!/usr/bin/env python3
"""Type into a field that cannot be written through, and record what landed.

The claim being proved is the one a unit test cannot reach: that a real element on a
real desktop — one that reads back and refuses every accessible write — can be typed
into with synthetic keystrokes, and that the service's account of what happened matches
what the field actually says afterwards. The unit tests prove the refusals and the
bookkeeping against a fake keyboard. Past the synthesis call is the X server, and no
test can follow it there.

The refusal is recorded first, deliberately. An artifact that only shows keystrokes
working leaves open the possibility that the accessible path would have worked too, and
this whole tier is only defensible where the honest path has already said no. The pair
is what shows the escalation was warranted rather than preferred.

Usage:
    python3 scripts/prove-keystrokes-live.py --application vesktop
    python3 scripts/prove-keystrokes-live.py --application vesktop --text "hello"

Nothing is sent. The text is typed and read back, and the field is left holding it —
committing a message is a separate act behind its own gate, and this script has no way
to perform one: a newline cannot be typed through this tier at all.
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
sys.path.insert(0, str(ROOT / "service"))

from desktop_service import errors, server  # noqa: E402
from desktop_service.backends import atspi, loop, session_env, x11  # noqa: E402

DEFAULT_OUT = "docs/proofs/keystrokes-reach-a-field-with-no-way-in.md"
DEFAULT_APPLICATION = "vesktop"

#: What gets typed when the caller does not say. Distinctive enough to be recognised in
#: a screenshot, harmless enough to be left sitting in a composer.
DEFAULT_TEXT = "keystroke tier proof"

MAX_LEGAL_DEPTH = 12

#: A password field would produce an unverifiable verdict by design, which is the
#: correct behaviour and a useless proof: the artifact could not show what landed.
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


def find_unwritable_field(window_id: str) -> tuple[str | None, list[str]]:
    """The field this tier exists for: reads back, offers nothing to write through.

    Found through the handlers a client would use rather than by a private walk, so the
    element the proof types into is one the registry has actually issued — the same
    reference a caller would be holding when it decided to escalate.

    Returns the element and every candidate considered, because "no such field here" is
    a finding worth writing down with its working shown.
    """
    tree = server._method_inspect_window(
        {"windowId": window_id, "depth": MAX_LEGAL_DEPTH, "maxNodes": 1000}
    )
    considered: list[str] = []
    for node, _depth in _walk(tree["window"]):
        if node["role"] not in SEARCH_ROLES:
            continue
        considered.append(f"{node['id']} ({node['role']}, {node.get('name') or 'unnamed'})")
        writable = loop.call_on_loop(
            lambda node=node: atspi.is_editable(server._resolve_element(node["id"])), timeout=10
        )
        if not writable:
            return node["id"], considered
    return None, considered


def attempt_the_honest_path(element_id: str, text: str) -> dict:
    """`typeText` first, and it is expected to refuse.

    This is the half of the proof that keystrokes alone cannot supply. A field that the
    accessible write could have handled is not evidence for a tier that exists only
    where it cannot.
    """
    try:
        result = server._method_type_text({"elementId": element_id, "text": text, "settleMs": 0})
    except errors.DesktopError as refused:
        return {"ok": False, "raised": refused.code, "message": refused.message}
    return result


def acceptance(refusal: dict, typed: dict, text: str, after: str) -> list[tuple[str, bool, str]]:
    """The conditions the issue asked for, each answered separately.

    Separately, because a single verdict would let a run that typed the text and lied
    about it read as a success. What the field says afterwards is checked here against
    the raw string, independently of the service's own verdict — the proof is allowed to
    disagree with the thing it is proving.
    """
    progress = typed.get("progress") or {}
    return [
        (
            "the accessible write refused this field first",
            refusal.get("ok") is False,
            f"typeText ok: {refusal.get('ok')}, "
            f"{(refusal.get('progress') or {}).get('stoppedBecause') or refusal.get('message')!r}",
        ),
        (
            "the keystroke tier accepted it",
            typed.get("ok") is True,
            f"ok: {typed.get('ok')}, stoppedBecause: {progress.get('stoppedBecause')!r}",
        ),
        (
            "the result says which backend answered",
            typed.get("backend") == "keystrokes",
            f"backend: {typed.get('backend')!r}",
        ),
        (
            "it named the window it took focus from",
            bool(progress.get("focusedWindow")),
            f"focusedWindow: {progress.get('focusedWindow')!r}",
        ),
        (
            "every character it planned was sent",
            progress.get("charactersTyped") == progress.get("charactersPlanned") == len(text),
            f"{progress.get('charactersTyped')}/{progress.get('charactersPlanned')}",
        ),
        (
            "the service verified the field itself",
            progress.get("verified") == "verified",
            f"verified: {progress.get('verified')!r}",
        ),
        (
            "the field really holds the text, read back independently of that verdict",
            text in after,
            f"read back: {after!r}",
        ),
    ]


def render(
    refusal: dict,
    typed: dict,
    after: str,
    text: str,
    env: dict[str, str],
    element_id: str,
    application: str,
) -> str:
    checks = acceptance(refusal, typed, text, after)
    passed = all(ok for _label, ok, _seen in checks)

    lines = [
        "# Proof: keystrokes reach a field with no way in",
        "",
        "Generated by `scripts/prove-keystrokes-live.py`. Not hand-written, and not",
        "reachable by a unit test: past the synthesis call is the X server, and the only",
        "way to know the characters arrived is to ask the application afterwards.",
        "",
        f"**Verdict: {'the claim holds' if passed else 'THE CLAIM DOES NOT HOLD'}**",
        "",
        "## Environment",
        "",
        "| | |",
        "|---|---|",
    ]
    lines += [f"| {key} | {value} |" for key, value in env.items()]
    lines += [
        f"| Application | {application} |",
        f"| Element | `{element_id}` |",
        "",
        "## What was asked of the run",
        "",
        "| Condition | Met | Observed |",
        "|---|---|---|",
    ]
    for label, ok, seen in checks:
        lines.append(f"| {label} | {'yes' if ok else 'NO'} | `{seen}` |")

    lines += [
        "",
        "## The refusal that made this warranted",
        "",
        "`typeText` was asked first, against the same element, in the same run. This tier",
        "is only defensible where the honest path has already said no, so the record of it",
        "saying no belongs in the same artifact as the record of the escalation.",
        "",
        "```json",
        json.dumps(refusal, indent=2, sort_keys=True),
        "```",
        "",
        "## The keystroke write",
        "",
        "```json",
        json.dumps(typed, indent=2, sort_keys=True),
        "```",
        "",
        "## What this does not say",
        "",
        "Nothing was sent. The text is left sitting in the field, unposted, because a",
        "newline cannot be typed through this tier at all — committing a message is a",
        "separate act behind its own gate.",
        "",
        "One desktop, one toolkit, one moment. The keycodes the clear-the-field sequence",
        "presses are a hardware assumption about an ordinary layout; a run on a keyboard",
        "that maps them elsewhere would fail the read-back, which is exactly how it would",
        "become visible.",
        "",
        "It says nothing about focus staying put. Focus was taken and the window it was",
        "taken from is recorded, but a person who clicked elsewhere mid-run would have",
        "received the rest of the characters, and the field would have failed to read back",
        "— a failure this artifact would then be showing instead.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--application", default=DEFAULT_APPLICATION)
    parser.add_argument("--text", default=DEFAULT_TEXT)
    args = parser.parse_args()

    if any(atspi.keysym_for(character) is None for character in args.text):
        print("that text cannot be typed as keystrokes on this keyboard", file=sys.stderr)
        return 1

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
            return 1

        element_id, considered = find_unwritable_field(window["id"])
        if element_id is None:
            print(
                f"{args.application} exposes no readable field that refuses to be written. "
                "That is a finding, not a failure of this script: this tier has nothing to "
                "prove here. Considered: " + (", ".join(considered) or "nothing"),
                file=sys.stderr,
            )
            return 1

        print(f"found {element_id} in {args.application}: reads back, cannot be written through")
        refusal = attempt_the_honest_path(element_id, args.text)
        print(f"  typeText: ok={refusal.get('ok')}")

        print(f"  typing {len(args.text)} characters — do not touch the keyboard")
        typed = server._method_type_keystrokes(
            {"elementId": element_id, "text": args.text, "settleMs": 200}
        )
        print(f"  typeKeystrokes: ok={typed.get('ok')} backend={typed.get('backend')}")

        # Read back once more, here rather than inside the service, so the artifact
        # carries a number the thing being proved did not produce.
        time.sleep(0.5)
        after = loop.call_on_loop(
            lambda: atspi.read_back(server._resolve_element(element_id), element_id), timeout=10
        )
    except KeyboardInterrupt:
        print("\ngave up", file=sys.stderr)
        return 1
    finally:
        loop.get_loop().stop()

    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        render(refusal, typed, after, args.text, environment(), element_id, args.application)
    )

    failed = [label for label, ok, _seen in acceptance(refusal, typed, args.text, after) if not ok]
    print(f"\n{out}: written")
    if failed:
        print("the run was recorded but does not meet: " + "; ".join(failed), file=sys.stderr)
        return 1
    print("every condition met")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
