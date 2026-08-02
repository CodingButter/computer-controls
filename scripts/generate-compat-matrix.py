#!/usr/bin/env python3
"""Generate the compatibility matrix by measuring this desktop, right now.

The matrix is never hand-written. A hand-written one describes the toolkits its
author remembers, ages silently, and cannot be re-run to check whether it is
still true. This script probes every application on the accessibility bus and
writes what it found, stamped with the environment it found it in — because the
results are only true for that environment, and a matrix that does not say which
one is a matrix that will eventually lie.

It accumulates rather than overwrites. An application that was not running when
this runs was not measured, and not measuring something is not a finding about
it: its row is carried forward with the date it was last measured on. Otherwise
every re-run would silently narrow the document to whichever applications one
person happened to have open, and a shrunken matrix looks exactly as
authoritative as a complete one.

Usage:
    python3 scripts/generate-compat-matrix.py --out docs/05-compatibility-matrix.md
"""

from __future__ import annotations

import argparse
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "service"))

from desktop_service import capabilities, probe  # noqa: E402
from desktop_service.backends import atspi, loop, session_env, x11  # noqa: E402


def environment() -> dict[str, str]:
    """What this measurement is true of."""

    def command(*argv: str) -> str:
        try:
            return subprocess.run(argv, capture_output=True, text=True, timeout=5).stdout.strip()
        except Exception:
            return ""

    # Discovered rather than read from this process's environment: a script run
    # from an SSH shell inherits a terminal's idea of the session and would
    # otherwise stamp the matrix "session type: tty" while measuring GNOME.
    borrowed = session_env.discover()

    def described(name: str, default: str) -> str:
        return os.environ.get(name) or borrowed.get(name) or default

    return {
        "Measured": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "Operating system": command("lsb_release", "-ds") or platform.platform(),
        "Kernel": platform.release(),
        "Desktop environment": borrowed.get("XDG_CURRENT_DESKTOP")
        or os.environ.get("XDG_CURRENT_DESKTOP", "unknown"),
        "Session type": borrowed.get("XDG_SESSION_TYPE") or described("XDG_SESSION_TYPE", "unknown"),
        "Display": x11.attached_display() or described("DISPLAY", "none"),
        "Python": platform.python_version(),
    }


def verdict(row: dict) -> str:
    """One word for what an agent can actually do with this application."""

    if row["windowCount"] == 0:
        return "no windows"
    # A GTK4 application puts its whole menu on the frame, so a handful of
    # actions is not the same surface as thirty. The threshold keeps Electron's
    # two-action frames out of a column that would imply they are driveable.
    if row["frameActionCount"] >= 10 and row["nodeCount"] <= 60:
        return "frame actions"
    # Tested after the frame, and the order is the finding rather than a
    # preference: a GTK4 application is driven by its frame whether or not the
    # walk below it ran out of depth, so saying "depth-limited" there would
    # describe the instrument and hide the surface. Where the frame is empty,
    # the ceiling is the honest answer — the node count that follows is a
    # property of this probe's twelve levels, not of the application.
    if row["depthLimited"]:
        return "depth-limited"
    if row["nodeCount"] > 60:
        return "walkable tree"
    if row["nodeCount"] > 1:
        return "shallow tree"
    return "opaque"


#: The table's columns, in order. Named here rather than spelled inline because
#: three functions now have to agree about them: the one that writes a freshly
#: measured row, the one that reads rows back out of a document written by an
#: earlier run, and the one that renders the result.
COLUMNS = [
    "Application",
    "Toolkit",
    "Windows",
    "Interfaces",
    "Depth",
    "Nodes",
    "Collection",
    "Frame actions",
    "Actionable elements",
    "Editable",
    "Verdict",
    "Measured",
]

#: Markdown alignments, one per column above: counts read right-aligned, words left.
ALIGNMENTS = [
    "---", "---", "---:", "---:", "---:", "---:",
    "---", "---:", "---:", "---:", "---", "---",
]


def row_cells(row: dict, measured: str) -> list[str]:
    """One measured application as the cells it will be written as."""

    collection = (
        "works"
        if row["collectionWorks"]
        else ("advertised only" if row["collectionAdvertised"] else "no")
    )
    depth = f"{row['reachableDepth']}{'+' if row['depthLimited'] else ''}"
    nodes = f"{row['nodeCount']}{'+' if row['nodeLimited'] else ''}"
    toolkit = row["toolkit"] + (f" {row['toolkitVersion']}" if row["toolkitVersion"] else "")
    return [
        str(row["name"]),
        toolkit or "unknown",
        str(row["windowCount"]),
        str(len(row["interfaces"])),
        depth,
        nodes,
        collection,
        str(row["frameActionCount"]),
        str(row["actionableElements"]),
        str(row["editableFields"]),
        verdict(row),
        measured,
    ]


def _cells_of(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def parse_environment(text: str) -> dict[str, str]:
    """The environment table of a document a previous run wrote."""

    env: dict[str, str] = {}
    for line in text.splitlines():
        if line.startswith("## Applications"):
            break
        if line.startswith("| ") and line.count("|") == 3:
            key, value = _cells_of(line)
            if key:  # the table's own headerless header row is not a fact about the session
                env[key] = value
    return env


def parse_existing(text: str) -> dict[str, list[str]]:
    """Rows a previous run wrote, keyed by application, in the order written.

    Read back as cells rather than re-derived as measurements, because that is
    what preserving a measurement means: a row recorded in March keeps March's
    numbers and March's verdict, and this run has no standing to recompute
    either from an application it did not look at.

    A row that cannot be read raises. The whole failure this function exists to
    end is a document losing rows without saying so, and a parser that skipped
    what it did not understand would reintroduce it one level down.
    """

    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith("| Application |"):
            header = _cells_of(line)
            break
    else:
        return {}

    # Rows written before the column existed carry the whole document's stamp:
    # it is the date they were measured on, recorded once instead of per row.
    fallback = parse_environment(text).get("Measured", "").split(" ")[0]

    rows: dict[str, list[str]] = {}
    for line in lines[index + 2 :]:
        if not line.startswith("|"):
            break
        cells = _cells_of(line)
        if len(cells) == len(header) == len(COLUMNS) - 1:
            if not fallback:
                raise ValueError(f"undated row with no environment stamp to inherit: {line}")
            cells = cells + [fallback]
        if len(cells) != len(COLUMNS):
            raise ValueError(f"cannot read row of the existing matrix: {line}")
        rows[cells[0]] = cells
    return rows


def merge(existing: dict[str, list[str]], fresh: dict[str, list[str]]) -> list[list[str]]:
    """Everything measured before, updated by everything measured now.

    Existing order is kept so that a regeneration reads as a diff of the numbers
    that changed rather than a reshuffle, and applications seen for the first
    time are appended. An application absent from `fresh` was not asked, and an
    unasked application is not a finding — its row stands, with the date it was
    taken on.
    """

    merged = {name: fresh.get(name, cells) for name, cells in existing.items()}
    for name, cells in fresh.items():
        if name not in merged:
            merged[name] = cells
    return list(merged.values())


def render(rows: list[list[str]], env: dict[str, str]) -> str:
    lines = [
        "# Compatibility matrix",
        "",
        "Generated by `scripts/generate-compat-matrix.py`. Do not edit by hand —",
        "re-run it instead, and if a row surprises you, that is the point of it.",
        "",
        "## Environment",
        "",
        "| | |",
        "|---|---|",
    ]
    lines += [f"| {key} | {value} |" for key, value in env.items()]
    lines += [
        "",
        "## Applications on the accessibility bus",
        "",
        "| " + " | ".join(COLUMNS) + " |",
        "|" + "|".join(ALIGNMENTS) + "|",
    ]
    lines += ["| " + " | ".join(cells) + " |" for cells in rows]

    lines += ["", "## Column meanings", ""]
    lines += [
        "- **Interfaces** — how many AT-SPI interfaces the application advertises. Advertising",
        "  one is a claim; the Collection column is the only one that tests a claim.",
        "- **Depth / Nodes** — how far the tree could actually be followed. A trailing `+` means",
        f"  the probe's own bound stopped it ({probe.MAX_PROBE_DEPTH} levels, {probe.MAX_PROBE_NODES} nodes),",
        "  not the application running out of tree.",
        "- **Collection** — `advertised only` is the interesting failure: the application offers",
        "  the fast filtered query and then declines to serve it, which is why the manual walk",
        "  exists as a fallback rather than an optimisation.",
        "- **Frame actions** — named actions on the window itself. GTK4 applications put nearly",
        "  their whole menu here, which is why a near-empty element tree is not the same as an",
        "  undriveable application.",
        "- **Actionable elements** — elements *below* the frame that expose at least one action,",
        "  within the walk bounds above. Read it together with the previous column and never",
        "  instead of it: a toolkit puts its actions on the frame or on its widgets, and a zero in",
        "  one column is a statement about where they live, not about whether they exist.",
        "- **Editable** — elements an agent could type into.",
        "- **Verdict** — which of those surfaces an agent would actually drive this application by.",
        "  `depth-limited` is not one of them: it says the walk stopped before the application did,",
        "  and that the counts on that row are the probe's reach rather than the application's size.",
        "",
        "> **Every row here is measured at depth 12, the maximum a window inspection may",
        "> ask for, and every Chromium-family row hits it.** Walked without a limit, the",
        "> same applications reach 952 nodes (Discord), 662 (Chrome) and 621 (code), with",
        '> their deepest content at depth 29 to 34. A "depth-limited" verdict means the',
        "> count in this table is a property of the instrument, not of the application.",
        "> See `07-open-questions.md`.",
        "",
        "## What this does not say",
        "",
        "AT-SPI exposes an application's *toolkit* version, never the application's own version,",
        "so no version column is offered rather than one being invented. An application nobody had",
        "open at measurement time was never asked, and is neither absent nor passing: its row stands",
        "with the date it was last measured on, which is what the Measured column is for. Only rows",
        "dated to the run described in the Environment table above were taken in that environment;",
        "an older row was taken in whatever the repository's history records for its own date.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="docs/05-compatibility-matrix.md")
    args = parser.parse_args()

    loop.get_loop().start()
    try:
        report = loop.call_on_loop(
            lambda: capabilities.build_report(
                probe_accessibility=atspi.probe_desktop,
                probe_capture=lambda: "",
                session_token="compat-matrix",
                observation_mode="poll",
            ),
            timeout=30.0,
        )
        tiers = {tier["id"]: tier for tier in report["tiers"]}
        if not tiers.get("accessibility", {}).get("available"):
            print("the accessibility bus is not available; nothing to measure", file=sys.stderr)
            return 1
        rows = loop.call_on_loop(lambda: [p.to_json() for p in probe.probe_all()], timeout=180.0)
    finally:
        loop.get_loop().stop()

    if not rows:
        print("no applications on the accessibility bus", file=sys.stderr)
        return 1

    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    existing = parse_existing(out.read_text()) if out.exists() else {}
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    fresh = {row["name"]: row_cells(row, today) for row in rows}
    merged = merge(existing, fresh)
    out.write_text(render(merged, environment()))
    carried = len(merged) - len(fresh)
    print(f"{out}: {len(fresh)} measured, {len(merged)} rows ({carried} carried forward)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
