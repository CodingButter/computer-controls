"""The compositor tier must find the desktop, not inherit it.

The service is meant to outlive whatever started it and to be driven by a client that is
somewhere else — another terminal, another machine, eventually none. Such a client hands
down no `DISPLAY`. A tier that only works when launched from inside a graphical session
would go quietly missing exactly when this project starts being what it is for, and the
symptom is not an error: focus simply stops working and the result says the fallback
failed.
"""

from __future__ import annotations

import os

import pytest

from desktop_service.backends import x11


@pytest.fixture
def forget_connection():
    """Each test gets a fresh attach, since the connection is cached per process."""
    saved = (x11._xlib, x11._unavailable_reason, x11._attached_display)
    x11._xlib, x11._unavailable_reason, x11._attached_display = None, "", ""
    yield
    x11._xlib, x11._unavailable_reason, x11._attached_display = saved


@pytest.mark.live
def test_it_attaches_with_no_display_in_the_environment(forget_connection, monkeypatch):
    """Marked live because it asserts discovery *succeeds*.

    The `/tmp/.X11-unix` check is not enough on its own: a host can carry sockets
    for displays it holds no authority over, and then discovery correctly finds
    nothing and this test correctly fails at proving something it cannot reach.
    """
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("XAUTHORITY", raising=False)

    if not os.path.isdir("/tmp/.X11-unix"):
        pytest.skip("no X server on this host")

    assert x11.available() is True, x11.unavailable_reason()
    assert x11.attached_display().startswith(":")
    assert x11.toplevels(), "attached to a display with no windows on it"


def test_an_explicit_display_is_honoured_rather_than_second_guessed(
    forget_connection, monkeypatch
):
    """Discovery is the fallback. A caller that names a display means it."""
    monkeypatch.setenv("DISPLAY", ":99")
    monkeypatch.delenv("XAUTHORITY", raising=False)

    assert x11.available() is False
    assert ":99" in x11.unavailable_reason()


def test_the_reason_names_every_display_it_tried(forget_connection, monkeypatch, tmp_path):
    """A failure that says only 'unavailable' costs an hour of looking in the dark."""
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setattr(os, "listdir", lambda path: ["X98", "X99"])
    monkeypatch.setenv("XAUTHORITY", str(tmp_path / "missing"))

    assert x11.available() is False
    reason = x11.unavailable_reason()
    assert ":98" in reason and ":99" in reason
