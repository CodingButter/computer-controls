#!/usr/bin/env python3
"""Ask a real desktop which condition makes a browser readable, and write down the answer.

The question this settles cannot be settled by argument, and it has been argued twice in
this repository already — first as "Electron withholds children", then as "the tree is
built while you walk it". Both were wrong, and both were wrong in the same way: a number
was explained rather than measured. So this script measures. It walks one condition per
run, records what the accessibility bus said and what `listApplications` returned, and
appends a row. Three runs make the comparison; one run makes a fact.

**It sets nothing up.** The operator arranges the condition and names it. That is not
laziness: the conditions worth testing are "a screen reader is running on your desktop"
and "the browser was started with a different command line", and a script that arranged
either of those would be doing on a person's desktop precisely what the service refuses
to do. The service will not start your screen reader or relaunch your browser, and
neither will its proof.

Conditions worth walking, in order:

    python3 scripts/prove-browser-visibility-live.py --condition "baseline: nothing attached"
    python3 scripts/prove-browser-visibility-live.py --condition "an assistive client is running"
    python3 scripts/prove-browser-visibility-live.py --condition "browser started with --force-renderer-accessibility"

If no condition produces a walkable tree, that verdict is the artifact. An honest
record of three failures is worth more than a fourth round of explanation.

Usage:
    python3 scripts/prove-browser-visibility-live.py --condition "baseline"
    python3 scripts/prove-browser-visibility-live.py --condition "baseline" --browser chrome
"""

from __future__ import annotations

import argparse
import os
import platform
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "service"))

from desktop_service import server  # noqa: E402
from desktop_service.backends import atspi, loop, session_env, x11  # noqa: E402

DEFAULT_OUT = "docs/proofs/which-condition-makes-a-browser-readable.md"

#: Matched as a substring against both the accessible name and whatever the display
#: server calls the process, because the two rarely agree: X11 says `google-chrome`
#: where the accessibility bus says `Google Chrome`.
DEFAULT_BROWSER = "chrome"

#: Deep enough to say something about the page rather than the chrome around it, and
#: the ceiling a client that declared attention on the application would be given.
WALK_DEPTH = 64
WALK_NODES = 1000

CLIENT = {"clientId": "prove-browser-visibility-live"}

TABLE_START = "<!-- rows: appended by scripts/prove-browser-visibility-live.py -->"
TABLE_END = "<!-- end rows -->"


def environment() -> dict[str, str]:
    """What this measurement is true of.

    Discovered rather than inherited, for the reason the compatibility matrix
    discovers it: run over SSH, this process's own environment would stamp the
    artifact `tty` while it measured a GNOME desktop.
    """

    def command(*argv: str) -> str:
        try:
            return subprocess.run(argv, capture_output=True, text=True, timeout=5).stdout.strip()
        except Exception:
            return ""

    borrowed = session_env.discover()
    return {
        "Operating system": command("lsb_release", "-ds") or platform.platform(),
        "Desktop environment": borrowed.get("XDG_CURRENT_DESKTOP")
        or os.environ.get("XDG_CURRENT_DESKTOP", "unknown"),
        "Session type": borrowed.get("XDG_SESSION_TYPE")
        or os.environ.get("XDG_SESSION_TYPE", "unknown"),
        "Display": x11.attached_display() or os.environ.get("DISPLAY", "none"),
        "Python": platform.python_version(),
    }


def _matches(browser: str, *candidates: str | None) -> bool:
    needle = browser.casefold()
    return any(needle in (candidate or "").casefold() for candidate in candidates)


def _count(node) -> int:
    return 1 + sum(_count(child) for child in node.get("children") or ())


def observe(browser: str) -> dict:
    """One run's worth of facts, gathered through the handlers a client would call.

    Through the handlers rather than by a private walk, because a proof that reached
    the browser by a path no caller has would be measuring this script.
    """
    status = loop.call_on_loop(atspi.assistive_client_announced, timeout=10)

    started = time.monotonic()
    listing = server._method_list_applications({**CLIENT})
    listing_ms = round((time.monotonic() - started) * 1000, 1)

    visible = [
        app
        for app in listing.get("applications") or ()
        if _matches(browser, app.get("name"))
    ]
    absent = [
        row
        for row in listing.get("invisibleApplications") or ()
        if _matches(browser, row.get("name"))
    ]

    found = {
        "status": status,
        "listingMs": listing_ms,
        "applicationCount": len(listing.get("applications") or ()),
        "invisibleCount": len(listing.get("invisibleApplications") or ()),
        "visible": visible,
        "absent": absent,
        "nodes": None,
        "windowTitle": None,
        "walkMs": None,
        "reason": absent[0]["reason"] if absent else None,
    }

    if not visible:
        return found

    # The tree is only worth counting where there is one. A node count is the whole
    # difference between "on the bus" and "readable": an application can answer
    # `listApplications` and still hand back a single node, which is the shape this
    # question was confused by twice before.
    server._method_set_attention({"applications": [visible[0]["name"]], "depth": "tree", **CLIENT})
    windows = [
        window
        for window in server._method_list_windows({**CLIENT})["windows"]
        if _matches(browser, window.get("applicationName"))
    ]
    if not windows:
        return found

    started = time.monotonic()
    tree = server._method_inspect_window(
        {"windowId": windows[0]["id"], "depth": WALK_DEPTH, "maxNodes": WALK_NODES, **CLIENT}
    )
    found["walkMs"] = round((time.monotonic() - started) * 1000, 1)
    found["nodes"] = _count(tree["window"])
    found["windowTitle"] = windows[0].get("title")
    return found


def row(condition: str, found: dict) -> str:
    status = found["status"]
    if status.get("available"):
        announced = (
            "yes"
            if status.get("isEnabled") or status.get("screenReaderEnabled")
            else "no"
        )
        announced += f" (IsEnabled {str(status.get('isEnabled')).lower()}, "
        announced += f"ScreenReaderEnabled {str(status.get('screenReaderEnabled')).lower()})"
    else:
        announced = f"unreadable — {status.get('reason')}"

    if found["visible"]:
        where = "listApplications"
    elif found["absent"]:
        where = "invisibleApplications"
    else:
        where = "neither — no window of it on this display"

    nodes = "—" if found["nodes"] is None else str(found["nodes"])
    title = found["windowTitle"] or "—"
    measured = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return (
        f"| {condition} | {announced} | {where} | {nodes} | {title} | "
        f"{found['listingMs']} ms | {measured} |"
    )


def skeleton(env: dict[str, str]) -> str:
    return "\n".join(
        [
            "# Proof: which condition makes a browser readable",
            "",
            "Generated by `scripts/prove-browser-visibility-live.py`, one row per run.",
            "Not hand-written, and not reachable by a unit test: whether Chromium builds a",
            "tree is decided inside Chromium, on a running desktop, in response to what else",
            "is on the accessibility bus.",
            "",
            "The script arranges nothing. Each row is a condition a person set up and named,",
            "measured immediately afterwards — which is the only honest way to record it,",
            "because the two conditions worth testing are starting a screen reader on",
            "somebody's desktop and relaunching their browser, and this service does neither.",
            "",
            "A row where the browser appears under `invisibleApplications` is not a failure of",
            "the run. It is the finding the issue asked for: the browser is running, the",
            "service can see it, and it says so instead of reporting an empty desktop.",
            "",
            "## Environment",
            "",
            "| | |",
            "|---|---|",
            *[f"| {key} | {value} |" for key, value in env.items()],
            "",
            "## Conditions measured",
            "",
            "| Condition | Assistive client announced | Browser appears under | Nodes | Window title | listApplications | Measured |",
            "|---|---|---|---|---|---|---|",
            TABLE_START,
            TABLE_END,
            "",
            "## What this does not say",
            "",
            "One desktop, one browser build, one moment each. It says nothing about whether a",
            "tree built under `--force-renderer-accessibility` is as complete as one built",
            "because a screen reader attached — only whether there is a tree at all.",
            "",
            "The node counts are this walk's reach, not the application's size: past the",
            "depth and node ceilings the walk stops and says so. Compare rows against each",
            "other, not against an absolute.",
            "",
        ]
    )


def append(path: Path, env: dict[str, str], line: str) -> None:
    """Append rather than overwrite, for the reason the compatibility matrix does.

    Each row cost somebody a deliberate act on a real desktop. A run that measured
    one condition has no business erasing the record of the other two.
    """
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(skeleton(env))
    text = path.read_text()
    if TABLE_START not in text or TABLE_END not in text:
        raise SystemExit(f"{path} has no row markers; move it aside and let this rewrite it")
    # Appended below the existing rows, so the table reads in the order the
    # conditions were walked: the baseline first, and whatever fixed it after.
    text = re.sub(
        re.escape(TABLE_END),
        line + "\n" + TABLE_END,
        text,
        count=1,
    )
    path.write_text(text)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--condition",
        required=True,
        help="what you arranged before running this, in your own words — it is the row's label",
    )
    parser.add_argument("--browser", default=DEFAULT_BROWSER)
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args()

    loop.get_loop().start()
    try:
        found = observe(args.browser)
    except KeyboardInterrupt:
        print("\ngave up", file=sys.stderr)
        return 1
    finally:
        loop.get_loop().stop()

    out = ROOT / args.out
    append(out, environment(), row(args.condition, found))

    print(f"{out}: row appended")
    print(f"  assistive status: {found['status']}")
    print(
        f"  {args.browser}: "
        + (
            f"readable, {found['nodes']} nodes"
            if found["visible"]
            else (
                "running and unreadable — reported under invisibleApplications"
                if found["absent"]
                else "not found on this display"
            )
        )
    )
    if found["reason"]:
        print(f"  reason given to callers: {found['reason']}")
    # Not a failure exit. Every condition this walks is a legitimate answer, including
    # the one where nothing works — the artifact is the point, not the verdict.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
