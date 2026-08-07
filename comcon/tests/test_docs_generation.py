"""Generated documentation must stay generated, and written links must land.

Three facts this suite holds to:

``03-tool-api.md`` is produced by a script from the frozen schema, so it cannot
drift from the contract the two bindings share. Regenerating it must yield the
same bytes — a hand-edit is the failure mode this catches. A generator that
alternates between two outputs would pass a single-run check on every other
invocation, so it is run twice.

The compatibility-matrix script is the only thing that writes the matrix, and
it must stay importable and runnable. Measuring a desktop needs a live
accessibility bus, which this lane does not have: the check is that the script
parses and imports cleanly (``--help``), not that it measures. A broken import
or a rotted CLI is what this catches; the measurement itself is a live concern.

Every relative link in ``docs/`` and the front-door README must resolve to a
file that exists. A link to a doc that was renamed or never written is a broken
promise, and a reader who follows one loses trust in the rest. External links
and same-page anchors are out of scope — they are not facts about this
repository.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")


def test_tool_api_doc_regeneration_is_idempotent() -> None:
    """Regenerating the tool-API doc from the schema produces no diff."""
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required to regenerate docs/03-tool-api.md")

    doc = DOCS / "03-tool-api.md"
    before = doc.read_text()

    generator = str(ROOT / "scripts" / "generate-tool-api-doc.mjs")
    subprocess.run([node, generator], cwd=ROOT, check=True, capture_output=True)
    first_pass = doc.read_text()
    assert first_pass == before, (
        "docs/03-tool-api.md changed on regeneration — it was edited by hand"
    )

    # A second run must also be a no-op: a generator that alternates between
    # two outputs passes the check above on every other invocation.
    subprocess.run([node, generator], cwd=ROOT, check=True, capture_output=True)
    assert doc.read_text() == first_pass, (
        "docs/03-tool-api.md is not stable across repeated generation"
    )


def test_compat_matrix_script_is_runnable() -> None:
    """The matrix script imports and parses cleanly.

    Actually measuring needs a live accessibility bus; ``--help`` proves the
    script has not rotted without depending on one.
    """
    script = str(ROOT / "scripts" / "generate-compat-matrix.py")
    result = subprocess.run(
        [sys.executable, script, "--help"],
        cwd=ROOT,
        capture_output=True,
    )
    assert result.returncode == 0, (
        f"generate-compat-matrix.py --help failed:\n{result.stderr.decode()}"
    )


def test_the_open_questions_doc_does_not_deny_the_keystroke_tier() -> None:
    """The written docs have to agree with the build about what the build does.

    Nothing checked this, and the §raw-input section spent a whole release saying
    that synthetic input bypasses the consent ceiling, the holds registry and the
    redaction layer — a true sentence about a general input driver, and a false one
    about the keystroke tier, which was written specifically to pass through all
    three. Regeneration cannot catch this: the document is hand-written, so a test
    is the only thing holding it to the code.
    """
    doc = (DOCS / "07-open-questions.md").read_text()
    section = doc[doc.index("### raw-input") :]

    assert "typeKeystrokes" in section, (
        "§raw-input must name the governed alternative that exists, or it reads as "
        "a denial that this build synthesizes keys at all"
    )
    for denial in (
        "Synthetic input bypasses the consent ceiling",
        "/dev/uinput",
        "xdotool",
    ):
        assert denial not in section, f"§raw-input still claims: {denial}"


def test_relative_links_resolve() -> None:
    """Every relative link in docs/ and README.md points at a real file."""
    markdown_files = sorted(DOCS.rglob("*.md"))
    markdown_files.append(ROOT / "README.md")

    broken: list[str] = []
    for md_file in markdown_files:
        text = md_file.read_text()
        for match in LINK_RE.finditer(text):
            target = match.group(2).strip()
            if target.startswith(("http://", "https://", "mailto:", "ftp://")):
                continue
            path_part = target.split("#")[0].split("?")[0]
            if not path_part:
                continue  # same-page anchor
            resolved = (md_file.parent / path_part).resolve()
            if not resolved.exists():
                broken.append(f"{md_file.relative_to(ROOT)} -> {target}")

    assert not broken, "broken relative links:\n" + "\n".join(broken)
