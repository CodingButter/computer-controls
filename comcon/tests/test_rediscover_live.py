"""The rediscoverer, against a real application.

A reference dies when the toolkit rebuilds a widget: the old D-Bus path stops
answering while an equivalent element still exists somewhere in the application.
That is what is reconstructed here — a dead reference from a live application —
because it is the only situation in which re-resolution can honestly help. An
element that merely moves keeps its path, and keeps its id.
"""

from __future__ import annotations

import os
import subprocess
import time

import pytest

from desktop_service import inspect as inspection
from desktop_service.backends import atspi, loop

APP = "gnome-text-editor"
APP_BINARY = "/usr/bin/gnome-text-editor"

pytestmark = pytest.mark.skipif(
    not os.path.exists(APP_BINARY), reason=f"{APP_BINARY} is not installed"
)


def _find_window():
    for app in atspi._iter_desktop_apps():
        if (app.get_name() or "") != APP:
            continue
        for window in atspi._windows_of(app):
            return window
    return None


@pytest.fixture(scope="module")
def live_window():
    loop.get_loop().start()
    spawned = None
    window = loop.call_on_loop(_find_window, timeout=15.0)
    if window is None:
        spawned = subprocess.Popen(
            [APP_BINARY], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and window is None:
            time.sleep(0.5)
            window = loop.call_on_loop(_find_window, timeout=15.0)
    if window is None:
        pytest.skip(f"{APP} did not expose a window over AT-SPI")
    yield window
    if spawned is not None:
        spawned.terminate()
        spawned.wait(timeout=10)


def _named_button(window):
    result = loop.call_on_loop(
        lambda: inspection.query(
            window,
            describe=atspi.describe,
            children=atspi.children_of,
            role="push button",
            limit=40,
        ),
        timeout=25.0,
    )
    for element in result.matches:
        if element.name:
            return element
    pytest.skip("no named button exposed")


def test_rediscovery_finds_the_same_button_behind_a_dead_reference(live_window):
    """A dead reference, a live twin, and one honest answer.

    The reference is killed the way the toolkit kills one — the object behind the
    id is dropped, leaving the id pointing at nothing while the button itself is
    still on screen. Rediscovery has to find it by what it is, not by where the
    caller last saw it.
    """
    button = _named_button(live_window)
    old = atspi.fingerprint_of({"id": button.id})
    assert old is not None, "the button should resolve before its reference dies"

    reference = dict(button.backend_reference)
    atspi._objects.pop(button.id, None)
    assert atspi.fingerprint_of({"id": button.id}) is None

    found = loop.call_on_loop(lambda: atspi.rediscover(old, reference), timeout=25.0)
    assert found is not None, "a button still on screen should be re-findable"

    new_id, new_reference, fingerprint = found
    assert fingerprint.role == old.role
    assert fingerprint.name == old.name
    assert new_reference["busName"] == reference["busName"]
    assert atspi.fingerprint_of({"id": new_id}) is not None, (
        "a re-resolved id is handed to the caller, so it has to resolve"
    )


def test_rediscovery_declines_when_the_application_is_gone(live_window):
    """No application, no answer — and no exception either."""
    gone = atspi.rediscover(
        atspi.fingerprint_of({"id": _named_button(live_window).id}),
        {"busName": ":0.999", "path": "/org/a11y/atspi/accessible/1"},
    )
    assert gone is None


def test_rediscovery_declines_without_a_bus_name():
    """An empty reference names no application, so there is nowhere to search."""
    from desktop_service.registry import Fingerprint

    assert atspi.rediscover(Fingerprint("push button", "Open", 0), {}) is None
