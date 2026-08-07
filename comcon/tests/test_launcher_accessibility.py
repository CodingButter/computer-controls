"""The daemon's own launches carry the accessibility flag.

Curing installed launchers fixes the shortcuts a person clicks. It does nothing
for a launch that starts here, because GIO reads the entry's own Exec line — so
without this, the one window the agent could not read would be the one it opened
itself.
"""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path

import pytest

from desktop_service.backends import launcher


@pytest.mark.parametrize(
    ("exec_line", "expected"),
    [
        ("/usr/bin/google-chrome-stable %U", True),
        ("/usr/bin/chromium --new-window", True),
        ("/usr/share/discord/Discord", True),
        ("env LANG=C /opt/brave.com/brave/brave-browser %U", True),
        ('"/opt/Obsidian/obsidian" %u', True),
        ("/usr/lib/firefox/firefox %u", False),
        ("nautilus --new-window %U", False),
        ("/usr/bin/gimp-2.10 %U", False),
    ],
)
def test_chromium_detection_matches_the_hub(exec_line: str, expected: bool) -> None:
    assert launcher.is_chromium_exec(exec_line) is expected


def test_flag_lands_after_the_program_and_before_the_field_codes() -> None:
    assert launcher.cure_exec_line("/usr/bin/chromium %U") == (
        f"/usr/bin/chromium {launcher.ACCESSIBILITY_FLAG} %U"
    )
    # The wrapper is not the program; the flag belongs to what it starts.
    assert launcher.cure_exec_line("env LANG=C /usr/bin/slack -s %U") == (
        f"env LANG=C /usr/bin/slack {launcher.ACCESSIBILITY_FLAG} -s %U"
    )


def test_curing_is_idempotent() -> None:
    cured = f"/usr/bin/chromium {launcher.ACCESSIBILITY_FLAG} %U"
    assert launcher.is_cured(cured)
    assert launcher.cure_exec_line(cured) == cured


def _stub_binary(directory: Path, name: str) -> Path:
    """A real executable with a Chromium-family basename.

    Required, not decorative: Gio.DesktopAppInfo.new_from_filename() returns
    None when argv[0] is not on PATH, so a fixture pointing at a name that does
    not exist fails in a way that looks like a binding bug.
    """
    binary = directory / name
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(binary.stat().st_mode | stat.S_IEXEC)
    return binary


def test_a_chromium_launch_is_rewritten_and_the_copy_is_cleaned_up(tmp_path, monkeypatch) -> None:
    binary = _stub_binary(tmp_path, "chromium")
    entry = tmp_path / "chromium.desktop"
    entry.write_text(
        f"[Desktop Entry]\nType=Application\nName=Chromium\n"
        f"Exec={binary} %U\nDBusActivatable=true\n"
    )

    from gi.repository import Gio

    info = Gio.DesktopAppInfo.new_from_filename(str(entry))
    assert info is not None, "fixture failed to load; is the stub binary executable?"

    accessible, cleanup = launcher._with_accessibility(info)
    try:
        assert accessible is not info, "a Chromium entry should launch through a cured copy"
        copy = Path(accessible.get_filename())
        text = copy.read_text()
        assert launcher.ACCESSIBILITY_FLAG in text
        # A bus-activated application never reads Exec, so the flag would be
        # dropped; the rewrite only means something with activation off.
        assert re.search(r"^DBusActivatable=false$", text, flags=re.MULTILINE)
    finally:
        cleanup()

    assert not copy.exists(), "the temporary launcher must not outlive the launch"


def test_a_non_chromium_launch_goes_through_its_own_entry_untouched(tmp_path) -> None:
    binary = _stub_binary(tmp_path, "nautilus")
    entry = tmp_path / "nautilus.desktop"
    before = f"[Desktop Entry]\nType=Application\nName=Files\nExec={binary} %U\n"
    entry.write_text(before)

    from gi.repository import Gio

    info = Gio.DesktopAppInfo.new_from_filename(str(entry))
    assert info is not None

    accessible, cleanup = launcher._with_accessibility(info)
    cleanup()

    assert accessible is info
    assert entry.read_text() == before, "the installed entry is never edited by a launch"


def test_an_already_flagged_entry_is_launched_as_it_stands(tmp_path) -> None:
    binary = _stub_binary(tmp_path, "chromium")
    entry = tmp_path / "chromium.desktop"
    entry.write_text(
        f"[Desktop Entry]\nType=Application\nName=Chromium\n"
        f"Exec={binary} {launcher.ACCESSIBILITY_FLAG} %U\n"
    )

    from gi.repository import Gio

    info = Gio.DesktopAppInfo.new_from_filename(str(entry))
    assert info is not None

    accessible, cleanup = launcher._with_accessibility(info)
    cleanup()

    assert accessible is info, "nothing to add means nothing to copy"


def test_a_launch_survives_an_unreadable_entry(tmp_path, monkeypatch) -> None:
    binary = _stub_binary(tmp_path, "chromium")
    entry = tmp_path / "chromium.desktop"
    entry.write_text(f"[Desktop Entry]\nType=Application\nName=Chromium\nExec={binary} %U\n")

    from gi.repository import Gio

    info = Gio.DesktopAppInfo.new_from_filename(str(entry))
    assert info is not None
    entry.unlink()

    accessible, cleanup = launcher._with_accessibility(info)
    cleanup()

    # The flag is a nicety; the launch is the job. A vanished file falls back.
    assert accessible is info


def test_the_chromium_list_has_not_drifted_from_the_hub() -> None:
    """The same list lives in TypeScript; two copies silently diverging is the risk."""
    source = Path(__file__).resolve().parents[2] / "client" / "src" / "curing" / "curing.ts"
    if not source.exists():
        pytest.skip("client checkout not present")

    block = re.search(
        r"CHROMIUM_BINARIES:\s*readonly string\[\]\s*=\s*\[(.*?)\]", source.read_text(), re.DOTALL
    )
    assert block is not None, "could not find CHROMIUM_BINARIES in curing.ts"
    hub = set(re.findall(r'"([^"]+)"', block.group(1)))

    assert hub == set(launcher.CHROMIUM_BINARIES), (
        "the hub's Chromium list and the daemon's have drifted; "
        "an application cured by one and not flagged by the other comes up unreadable"
    )
