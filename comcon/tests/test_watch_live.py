"""The event stream, against the real desktop.

The unit tests prove the watcher's timings. They cannot prove the one thing that actually
went wrong here: the service subscribed successfully to every event it wanted and received
none of them, because the loop was running a GLib context the toolkit was not talking to.
Registration returned true, calls kept working, and the desktop simply never spoke.

That failure is invisible to any test that fakes the event source, so this one does not.
"""

from __future__ import annotations

import threading
import time

import pytest

from desktop_service import server, watch
from desktop_service.backends import atspi, loop, x11


def activate_and_settle(xid: int, timeout: float = 3.0) -> bool:
    """Move focus and wait for the display server to agree that it moved.

    Without the wait, a test can prime its view of the desktop while the previous test's
    focus change is still in flight, then ask for a change that has already happened. The
    failure looks exactly like a broken event stream, which is an expensive thing to
    debug twice.
    """
    x11.activate(xid)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if x11.active_xid() == xid:
            return True
        time.sleep(0.05)
    return False


@pytest.fixture(scope="module")
def desktop():
    running_loop = loop.get_loop()
    started_here = not running_loop.is_running
    if started_here:
        running_loop.start()
    if not x11.available():
        pytest.skip(f"no display: {x11.unavailable_reason()}")
    yield
    if started_here:
        running_loop.stop()


def test_the_desktop_reaches_the_watcher_through_a_real_event(desktop):
    """A focus change the service did not cause has to arrive on its own."""
    heard = threading.Event()
    unsubscribe = loop.call_on_loop(atspi.watch_events, heard.set)
    try:
        windows = {w.xid: w.title for w in x11.toplevels()}
        active = x11.active_xid()
        others = [xid for xid, title in windows.items() if xid != active and title]
        if not others:
            pytest.skip("no second window to move focus to")

        activate_and_settle(others[0])
        try:
            assert heard.wait(timeout=5), (
                "the desktop changed and no event arrived — the loop is probably running "
                "a GLib context AT-SPI is not dispatching on"
            )
        finally:
            activate_and_settle(active)
    finally:
        loop.call_on_loop(unsubscribe)


def test_an_external_change_becomes_a_published_delta(desktop):
    """End to end, in the order it happens in production: event, debounce, re-read, delta.

    Nothing here tells the watcher what changed. The event says only 'look again', and
    everything in the delta comes from the re-read.
    """
    published: list[watch.Delta] = []
    watcher = watch.Watcher(
        sample=server._watch_sample,
        publish=published.append,
        schedule=loop.after,
        now_ms=lambda: int(time.monotonic() * 1000),
        cadence=watch.Cadence(debounce_ms=200, ceiling_ms=2000),
    )
    windows = {w.xid: w.title for w in x11.toplevels()}
    active = x11.active_xid()
    others = [xid for xid, title in windows.items() if xid != active and title]
    if not others:
        pytest.skip("no second window to move focus to")

    # Prime the engine so the first real change is a change and not the whole desktop
    # arriving at once. Primed after the desktop is known to be still, or the change this
    # test is about would already be in the picture before the test causes it.
    server._watch_sample()

    unsubscribe = loop.call_on_loop(atspi.watch_events, watcher.hint)
    try:
        assert activate_and_settle(others[0]), "the window manager refused the focus change"
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and not published:
            time.sleep(0.05)
        activate_and_settle(active)

        assert published, "the desktop moved and no delta was published"
        kinds = {change["kind"] for delta in published for change in delta.changes}
        assert "focus-changed" in kinds, kinds
    finally:
        loop.call_on_loop(unsubscribe)
        watcher.stop()
