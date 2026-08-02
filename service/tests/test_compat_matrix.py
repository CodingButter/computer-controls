"""The matrix generator, held to the two things a record has to do.

A record has to keep what it recorded, and it has to say when. The generator did
neither: it measured the accessibility bus and wrote the whole file, so an
application that happened not to be running when someone re-ran it did not
produce a weaker row — it produced no row, and the numbers measured for it in an
earlier session were gone. Three applications were lost that way in one morning,
and the file that lost them still looked authoritative afterwards, because a
matrix gives no sign of the size it used to be.

These tests are arithmetic over text and need no desktop. That is deliberate: the
data loss is not in the probing, which is honest about what it found, but in the
writing, which is the half that can be proved anywhere.

The generator lives in `scripts/`, is named with hyphens and is meant to be run
rather than imported, so it is loaded here by path rather than by name.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
MATRIX = ROOT / "docs" / "05-compatibility-matrix.md"


def _load_generator() -> Any:
    path = ROOT / "scripts" / "generate-compat-matrix.py"
    spec = importlib.util.spec_from_file_location("generate_compat_matrix", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


generator = _load_generator()


def _cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _table(text: str) -> list[dict[str, str]]:
    """The applications table as a list of column-name to cell mappings.

    Read by column name rather than by position so that adding a column does not
    quietly change what a test is asserting about.
    """

    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith("| Application |"):
            header = _cells(line)
            break
    else:
        raise AssertionError("no applications table in the document")

    rows = []
    for line in lines[index + 2 :]:
        if not line.startswith("|"):
            break
        rows.append(dict(zip(header, _cells(line))))
    return rows


def _without_the_measured_column(text: str) -> str:
    """The same document as a version of the generator that predates dates wrote it."""

    lines = text.splitlines()
    for index, line in enumerate(lines):
        if not line.startswith("| Application |"):
            continue
        if not line.rstrip().endswith("| Measured |"):
            break  # already such a document
        for offset, row in enumerate(lines[index:]):
            if not row.startswith("|"):
                break
            lines[index + offset] = row.rstrip().rsplit("|", 2)[0] + "|"
        break
    return "\n".join(lines) + "\n"


def _measured_row(**overrides: Any) -> dict[str, Any]:
    """A probe result shaped as `probe.ApplicationProbe.to_json` returns it."""

    row = {
        "name": "example",
        "toolkit": "gtk",
        "toolkitVersion": "3.24.41",
        "interfaces": ["Accessible", "Component"],
        "windowCount": 1,
        "reachableDepth": 8,
        "nodeCount": 109,
        "depthLimited": False,
        "nodeLimited": False,
        "collectionAdvertised": True,
        "collectionWorks": True,
        "frameActionCount": 0,
        "actionableElements": 54,
        "editableFields": 0,
    }
    row.update(overrides)
    return row


class TestVerdict:
    """The word in the last column, and the retraction hiding behind it."""

    def test_reproduces_every_verdict_in_the_committed_matrix(self) -> None:
        """The generator must say what the document already says.

        Three of these rows read `depth-limited`, a word the generator could not
        produce when it was written: they were corrected by hand in the commit
        that retracted two Electron findings, and the next regeneration would
        have reverted the retraction without a word. Recomputing every recorded
        verdict from its own row is what makes that impossible to do quietly —
        if the rule and the document ever disagree again, this fails.
        """

        rows = _table(MATRIX.read_text())
        assert len(rows) >= 20, "the committed matrix should carry a desktop's worth of rows"

        for row in rows:
            recomputed = generator.verdict(
                {
                    "windowCount": int(row["Windows"]),
                    "frameActionCount": int(row["Frame actions"]),
                    "nodeCount": int(row["Nodes"].rstrip("+")),
                    "depthLimited": row["Depth"].endswith("+"),
                }
            )
            assert recomputed == row["Verdict"], f"{row['Application']} changed verdict"

    def test_a_frame_driven_application_is_not_called_depth_limited(self) -> None:
        """Order of the two rules, stated as the finding it is.

        A GTK4 application puts its menu on the frame and leaves almost nothing
        below it, so its walk hits the ceiling with a nearly empty tree. Calling
        that `depth-limited` would describe the probe and bury the fact that the
        application is fully driveable through its frame.
        """

        assert (
            generator.verdict(
                _measured_row(frameActionCount=60, nodeCount=49, depthLimited=True)
            )
            == "frame actions"
        )

    def test_a_walk_stopped_by_the_ceiling_says_so(self) -> None:
        assert (
            generator.verdict(
                _measured_row(frameActionCount=2, nodeCount=30, depthLimited=True)
            )
            == "depth-limited"
        )

    def test_an_unlimited_walk_is_judged_by_what_it_found(self) -> None:
        assert generator.verdict(_measured_row(nodeCount=109)) == "walkable tree"
        assert generator.verdict(_measured_row(nodeCount=18)) == "shallow tree"
        assert generator.verdict(_measured_row(nodeCount=1)) == "opaque"
        assert generator.verdict(_measured_row(windowCount=0, nodeCount=0)) == "no windows"


class TestDepthCeilingNote:
    def test_regeneration_keeps_it(self) -> None:
        """Prose the document needs and the generator used to lack.

        The paragraph naming our depth ceiling arrived by hand alongside the
        corrected verdicts. Prose that only exists in the output of a generator
        that overwrites its output is prose with a countdown on it.
        """

        rendered = generator.render([generator.row_cells(_measured_row(), "2026-08-02")], {})
        assert "property of the instrument" in rendered
        assert "07-open-questions.md" in rendered


def _regenerate(path: Path, measured: list[dict], date: str) -> None:
    """A run of the generator with the probing replaced by a given result."""

    existing = generator.parse_existing(path.read_text()) if path.exists() else {}
    fresh = {row["name"]: generator.row_cells(row, date) for row in measured}
    path.write_text(generator.render(generator.merge(existing, fresh), {"Measured": date}))


class TestRegeneration:
    def test_an_application_that_was_not_running_keeps_its_row(self, tmp_path: Path) -> None:
        """The failure this whole change exists for.

        Two applications are measured, then one of them is closed and the matrix
        regenerated. The row for the closed one has to survive untouched — same
        numbers, same verdict, same date — because nothing was learned about it.
        Losing it is not a weaker claim, it is the loss of a measurement nobody
        can reconstruct without that machine, that session and that day.
        """

        out = tmp_path / "matrix.md"
        _regenerate(
            out,
            [_measured_row(name="audacity", nodeCount=571, actionableElements=390)],
            "2026-03-04",
        )
        before = _table(out.read_text())

        _regenerate(out, [_measured_row(name="zoom", nodeCount=237)], "2026-08-02")
        after = {row["Application"]: row for row in _table(out.read_text())}

        assert after["audacity"] == before[0]
        assert after["audacity"]["Nodes"] == "571"
        assert after["audacity"]["Measured"] == "2026-03-04"
        assert after["zoom"]["Measured"] == "2026-08-02"

    def test_a_measured_application_is_updated_in_place(self, tmp_path: Path) -> None:
        out = tmp_path / "matrix.md"
        _regenerate(out, [_measured_row(name="zoom", nodeCount=237)], "2026-03-04")
        _regenerate(out, [_measured_row(name="zoom", nodeCount=240)], "2026-08-02")

        rows = _table(out.read_text())
        assert [row["Application"] for row in rows] == ["zoom"]
        assert rows[0]["Nodes"] == "240"
        assert rows[0]["Measured"] == "2026-08-02"

    def test_every_row_says_when_it_was_measured(self, tmp_path: Path) -> None:
        out = tmp_path / "matrix.md"
        _regenerate(out, [_measured_row(name="audacity")], "2026-03-04")
        _regenerate(out, [_measured_row(name="zoom")], "2026-08-02")

        for row in _table(out.read_text()):
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", row["Measured"]), row

    def test_order_is_stable_and_new_applications_are_appended(self, tmp_path: Path) -> None:
        """So that a regeneration reads as a diff rather than a reshuffle."""

        out = tmp_path / "matrix.md"
        _regenerate(
            out,
            [_measured_row(name=name) for name in ("audacity", "zoom", "code")],
            "2026-03-04",
        )
        _regenerate(
            out,
            [_measured_row(name=name) for name in ("code", "vesktop", "audacity")],
            "2026-08-02",
        )

        assert [row["Application"] for row in _table(out.read_text())] == [
            "audacity",
            "zoom",
            "code",
            "vesktop",
        ]


class TestReadingBackAnOlderDocument:
    def test_undated_rows_inherit_the_documents_own_stamp(self, tmp_path: Path) -> None:
        """The migration case, and the only honest date available for it.

        A matrix written before the column existed still records when it was
        measured — once, in its environment table. Every row in it was taken in
        that run, so that is the date they carry.
        """

        out = tmp_path / "matrix.md"
        out.write_text(_without_the_measured_column(MATRIX.read_text()))

        rows = generator.parse_existing(out.read_text())
        assert len(rows) >= 20
        for name, cells in rows.items():
            assert cells[-1] == "2026-08-02", name

    def test_a_row_it_cannot_read_is_an_error_not_a_deletion(self, tmp_path: Path) -> None:
        """A swallowed parse error is the original bug wearing a different hat."""

        out = tmp_path / "matrix.md"
        out.write_text(
            "## Applications on the accessibility bus\n\n"
            "| " + " | ".join(generator.COLUMNS) + " |\n"
            "|" + "|".join(generator.ALIGNMENTS) + "|\n"
            "| audacity | gtk | 1 |\n"
        )
        with pytest.raises(ValueError):
            generator.parse_existing(out.read_text())
