"""The gate that decides which tests need a desktop, tested without one.

A skip rule is the one piece of a suite that nobody notices when it is wrong:
too eager and the live tests quietly stop running, too reluctant and a headless
machine reports a regression that is really an absent display. So the rule is
exercised directly rather than trusted, and the machine's real answer is
substituted for a hypothetical one in both directions.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

#: The gate lives at the repository root, one level above the service, because
#: the service is no longer the only thing with a suite under it.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import conftest as gate
from desktop_service.backends import x11


class _Config:
    def __init__(self, **options):
        self._options = options

    def getoption(self, name):
        return self._options.get(name, False)


def test_a_reachable_desktop_deselects_nothing(monkeypatch):
    monkeypatch.setattr(x11, "available", lambda: True)
    assert gate._why_live_is_unavailable(_Config()) == ""


def test_an_unreachable_desktop_says_why(monkeypatch):
    monkeypatch.setattr(x11, "available", lambda: False)
    monkeypatch.setattr(x11, "unavailable_reason", lambda: "no DISPLAY and none discovered")

    reason = gate._why_live_is_unavailable(_Config())

    assert "no desktop session is reachable" in reason
    assert "no DISPLAY and none discovered" in reason


def test_a_probe_that_explodes_is_still_an_answer(monkeypatch):
    """The probe touches ctypes and a socket, and neither is obliged to behave.

    A crash here would abort collection for the whole suite, including the two
    hundred and ninety-one tests that never wanted a desktop in the first place.
    """
    def explode():
        raise OSError("libX11 is not installed")

    monkeypatch.setattr(x11, "available", explode)

    assert "libX11 is not installed" in gate._why_live_is_unavailable(_Config())


def test_the_suffix_is_what_makes_a_test_live():
    """Named so that a new live test is marked by being named honestly.

    A marker somebody has to remember to write is a marker somebody forgets.
    """
    assert gate.LIVE_SUFFIX == "_live"


@pytest.mark.parametrize("flag", ["--no-live", "--live-only"])
def test_the_flags_are_reasons_not_silence(flag):
    reason = gate._why_live_is_unavailable(_Config(**{"--no-live": flag == "--no-live"}))

    if flag == "--no-live":
        assert reason == "deselected by --no-live"
    else:
        assert "--no-live" not in reason
