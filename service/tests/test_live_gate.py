"""The gate that decides which tests need a desktop, tested without one.

A skip rule is the one piece of a suite that nobody notices when it is wrong:
too eager and the live tests quietly stop running, too reluctant and a headless
machine reports a regression that is really an absent display. So the rule is
exercised directly rather than trusted, and the machine's real answer is
substituted for a hypothetical one in both directions.
"""

from __future__ import annotations

import os
import sys
import types
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
        self.markers: list[str] = []

    def getoption(self, name):
        return self._options.get(name, False)

    def addinivalue_line(self, name, line):
        if name == "markers":
            self.markers.append(line)


class _Item:
    """A collected test, reduced to the three things the gate touches.

    The gate is asked about tests that do not exist here — a live one, a human
    one, one that is both — because the interesting cases are combinations no
    single real module happens to be, and because synthesising them is how this
    file proves a desktop rule without a desktop.
    """

    def __init__(self, module_name: str, marks: tuple[str, ...] = ()):
        self.module = types.SimpleNamespace()
        self.module.__name__ = module_name
        self.markers = [getattr(pytest.mark, mark) for mark in marks]

    def get_closest_marker(self, name):
        for marker in self.markers:
            if marker.name == name:
                return marker
        return None

    def add_marker(self, marker):
        self.markers.append(marker)

    @property
    def skip_reason(self) -> str:
        for marker in self.markers:
            if marker.name == "skip":
                return marker.kwargs.get("reason", "")
        return ""


def _collect(items, monkeypatch, *, display: bool, human: str | None, **options):
    """Run the gate over synthesised items with the machine's answers supplied."""
    monkeypatch.setattr(x11, "available", lambda: display)
    monkeypatch.setattr(x11, "unavailable_reason", lambda: "no DISPLAY and none discovered")
    if human is None:
        monkeypatch.delenv(gate.HUMAN_PRESENT_ENV, raising=False)
    else:
        monkeypatch.setenv(gate.HUMAN_PRESENT_ENV, human)

    gate.pytest_collection_modifyitems(_Config(**options), items)
    return items


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


def test_a_desktop_is_not_a_person(monkeypatch):
    """The load-bearing one, and the reason the third lane exists at all.

    The live lane runs unattended in the small hours on a machine that has a
    display. If presence were inferred from the display, every human proof would
    start running there with nobody to answer it — passing, hanging or failing
    depending on the weather.
    """
    (item,) = _collect([_Item("test_takeover", ("human",))], monkeypatch, display=True, human=None)

    assert "needs a person at the keyboard" in item.skip_reason
    assert gate.HUMAN_PRESENT_ENV in item.skip_reason


def test_the_variable_selects_them(monkeypatch):
    (item,) = _collect([_Item("test_takeover", ("human",))], monkeypatch, display=True, human="1")

    assert item.skip_reason == ""


@pytest.mark.parametrize("value", ["1", "0", "no", "false", "  ", "yes please"])
def test_any_value_at_all_means_a_person_said_so(value, monkeypatch):
    """Set is the whole test. A truthiness table would be a second thing to know.

    ``DESKTOP_HUMAN_PRESENT=0`` reads like a denial, and answering it as one
    would be defensible — but only at the price of a rule nobody can predict
    without reading this file. Somebody who typed the variable meant it.
    """
    (item,) = _collect([_Item("test_takeover", ("human",))], monkeypatch, display=True, human=value)

    assert item.skip_reason == ""


def test_an_empty_value_is_nobody(monkeypatch):
    """What a shell leaves behind when a variable is cleared rather than removed."""
    (item,) = _collect([_Item("test_takeover", ("human",))], monkeypatch, display=True, human="")

    assert "needs a person at the keyboard" in item.skip_reason


def test_the_missing_desktop_is_named_before_the_missing_person(monkeypatch):
    """Both are absent in a container; the one you could act on is the display."""
    (item,) = _collect([_Item("test_drill_live", ("human",))], monkeypatch, display=False, human=None)

    assert "no desktop session is reachable" in item.skip_reason
    assert "keyboard" not in item.skip_reason


def test_the_missing_person_is_named_once_the_desktop_answers(monkeypatch):
    (item,) = _collect([_Item("test_drill_live", ("human",))], monkeypatch, display=True, human=None)

    assert "needs a person at the keyboard" in item.skip_reason


def test_the_live_lane_is_not_weakened_by_the_new_one(monkeypatch):
    """A human lane that made the thirty-eight optional would be a regression.

    They need a desktop and not a person: they run unattended, and they should
    keep gating merges exactly as they did before this marker existed.
    """
    live, portable = _collect(
        [_Item("test_drill_live"), _Item("test_registry")],
        monkeypatch,
        display=True,
        human=None,
    )

    assert live.skip_reason == ""
    assert portable.skip_reason == ""

    live, portable = _collect(
        [_Item("test_drill_live"), _Item("test_registry")],
        monkeypatch,
        display=True,
        human=None,
        **{"--live-only": True},
    )

    assert live.skip_reason == ""
    assert portable.skip_reason == "deselected by --live-only"

    live, portable = _collect(
        [_Item("test_drill_live"), _Item("test_registry")],
        monkeypatch,
        display=True,
        human=None,
        **{"--no-live": True},
    )

    assert live.skip_reason == "deselected by --no-live"
    assert portable.skip_reason == ""


def test_the_marker_is_registered_so_strict_markers_stays_usable():
    config = _Config()

    gate.pytest_configure(config)

    assert any(line.startswith("human:") for line in config.markers)
    assert any(line.startswith("live:") for line in config.markers)


@pytest.mark.human
def test_the_human_lane_only_runs_when_a_person_said_so():
    """The canary, and the only test in this repository that wants a person.

    It asserts the very thing that let it run. Deselected, it costs nothing;
    selected by a gate that has stopped working, it fails immediately and names
    the lane — which is better than a human proof further down the suite hanging
    on input nobody is there to type.
    """
    assert os.environ.get(gate.HUMAN_PRESENT_ENV), (
        "collected without "
        f"{gate.HUMAN_PRESENT_ENV} set — the human lane's default has been broken"
    )
