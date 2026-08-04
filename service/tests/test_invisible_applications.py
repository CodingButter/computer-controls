"""An application that is running and unreadable is not an application that is absent.

`listApplications` answers from the accessibility bus, and an application that never
joined it is simply not mentioned. From outside, that is indistinguishable from the
application not running — which is how a live session was told that Chrome, filling
half the screen at the time, was not there. The fix is not to make the browser readable;
this service does not get to reconfigure other people's applications. It is to report
the absence as an absence, with the reason attached.

The tests that carry weight here are the last two kinds. One pins that reporting an
application never launches, relaunches or reconfigures anything — the tempting fix is
exactly the forbidden one. The other pins that the consent ceiling reaches these rows
too: an application the user walled off must not announce itself through the list that
exists to describe what cannot be read.
"""

from __future__ import annotations

import pytest

from desktop_service import attention, security, server
from desktop_service.backends import atspi, launcher, x11


@pytest.fixture(autouse=True)
def clean_attention():
    attention.clear()
    yield
    attention.clear()


@pytest.fixture()
def open_desktop():
    """No ceiling in the way, so anything withheld is withheld by the code under test."""
    previous = server._consent
    server._consent = security.Consent(
        security.Ceiling(classes=frozenset(security.OPERATION_CLASSES))
    )
    yield
    server._consent = previous


def walled(*blocked: str):
    return security.Consent(
        security.Ceiling(
            classes=frozenset({"observe"}),
            blocked_applications=frozenset(blocked),
        )
    )


#: Two applications on the accessibility bus, and a third that has windows and no
#: application behind them — the shape of a desktop with a browser running on it.
ON_THE_BUS = [
    {"id": "app-aaa", "name": "some-editor", "pid": 11},
    {"id": "app-bbb", "name": "a-terminal", "pid": 22},
]
BUS_PIDS = {"app-aaa": 11, "app-bbb": 22}
TOPLEVELS = [
    x11.X11Window(xid=1, pid=11, title="notes", wm_class="Some-editor"),
    x11.X11Window(xid=2, pid=22, title="bash", wm_class="Some-terminal"),
    x11.X11Window(xid=3, pid=33, title="cats - Google Search", wm_class="Google-chrome"),
    x11.X11Window(xid=4, pid=33, title="downloads", wm_class="Google-chrome"),
]


@pytest.fixture()
def desktop(monkeypatch):
    """A desktop where the third application is invisible to the accessibility layer."""
    monkeypatch.setattr(atspi, "application_pids", lambda: dict(BUS_PIDS))
    monkeypatch.setattr(atspi, "list_applications", lambda: [dict(row) for row in ON_THE_BUS])
    monkeypatch.setattr(x11, "toplevels", lambda: list(TOPLEVELS))
    monkeypatch.setattr(atspi, "_process_name", lambda pid: {33: "chrome"}.get(pid, ""))
    # The handlers hop onto the toolkit thread; in-process there is no loop to hop to.
    monkeypatch.setattr(server.loop, "call_on_loop", lambda fn, *a, **k: fn(*a))


def test_an_application_absent_from_the_accessibility_tree_is_reported_as_absent_not_as_empty(
    desktop, open_desktop
):
    result = server._method_list_applications({"clientId": "cl-1"})

    assert [row["name"] for row in result["applications"]] == ["some-editor", "a-terminal"]

    absent = result["invisibleApplications"]
    assert len(absent) == 1
    row = absent[0]
    assert row["name"] == "Google-chrome"
    assert row["pid"] == 33
    # Both of its windows, counted — "it is running" is not the whole answer; "it has
    # two windows you cannot read" is.
    assert row["windowCount"] == 2
    assert row["backend"] == x11.BACKEND
    assert "accessibility bus" in row["reason"]
    # Nothing about what is on screen. A window title is the sensitive half of a
    # window, and there is no inspection to justify carrying one here.
    assert "cats" not in repr(row)
    # An internal matching aid, never part of the answer.
    assert "identityCandidates" not in row


def test_the_service_never_relaunches_an_application_to_gain_visibility(
    desktop, open_desktop, monkeypatch
):
    """The forbidden fix, pinned.

    Chromium builds its accessibility tree once an assistive client announces itself,
    so the shortcut is to announce one, or to restart the browser with the flag that
    forces it. Both mean this service reaching into an application the user is using
    and changing how it runs. Reporting is allowed to observe and to explain; it is
    not allowed to act.
    """

    def forbidden(*args, **kwargs):
        raise AssertionError("the reporting path acted on the desktop")

    monkeypatch.setattr(launcher, "launch", forbidden)
    monkeypatch.setattr(atspi, "grab_focus", forbidden)

    result = server._method_list_applications({"clientId": "cl-1"})
    assert result["invisibleApplications"][0]["pid"] == 33


def test_a_walled_off_application_stays_absent_under_every_name_it_answers_to(desktop):
    """The ceiling reaches these rows, matched conservatively.

    The row is named from `WM_CLASS` and `/proc`, which disagree about case and about
    length: this browser is `Google-chrome` to the display server and `chrome` to the
    kernel. A ceiling that blocks `google-chrome` must withhold it either way, so the
    block match runs in both directions — the plain substring test used everywhere
    else passes `chrome` straight through.
    """
    previous = server._consent
    server._consent = walled("google-chrome")
    try:
        result = server._method_list_applications({"clientId": "cl-1"})
        assert result["invisibleApplications"] == []
    finally:
        server._consent = previous


def test_a_walled_off_application_stays_absent_when_only_the_short_name_survives(
    monkeypatch,
):
    """The direction a plain substring match gets wrong.

    A window that sets no `WM_CLASS` can only be named by what the kernel calls its
    process — `chrome`, where the configuration says `google-chrome`. Asking whether
    the configured name appears inside the row's name answers no, and the walled-off
    browser is announced. The match therefore runs both ways, which errs towards
    withholding: the cost of being wrong here is a row that should have been shown,
    and the cost of being wrong the other way is the thing the wall exists to prevent.
    """
    monkeypatch.setattr(atspi, "application_pids", lambda: {})
    monkeypatch.setattr(atspi, "list_applications", lambda: [])
    monkeypatch.setattr(atspi, "_process_name", lambda pid: "chrome")
    monkeypatch.setattr(
        x11, "toplevels", lambda: [x11.X11Window(xid=9, pid=33, title="cats", wm_class="")]
    )
    monkeypatch.setattr(server.loop, "call_on_loop", lambda fn, *a, **k: fn(*a))

    previous = server._consent
    server._consent = walled("google-chrome")
    try:
        assert server._method_list_applications({"clientId": "cl-1"})["invisibleApplications"] == []
    finally:
        server._consent = previous


def test_an_invisible_row_is_narrowed_by_attention_like_any_other(desktop, open_desktop):
    attention.declare("cl-scoped", ["some-editor"], attention.SURFACE)
    result = server._method_list_applications({"clientId": "cl-scoped"})
    assert result["invisibleApplications"] == []

    attention.declare("cl-watching", ["chrome"], attention.SURFACE)
    result = server._method_list_applications({"clientId": "cl-watching"})
    assert [row["pid"] for row in result["invisibleApplications"]] == [33]


def test_windows_that_are_not_applications_produce_no_row(monkeypatch, open_desktop):
    """A desktop is full of toplevels nobody would call an application.

    Panels and the desktop's own icon layer are windows; a splash screen with no name
    is a window; a window whose process the display server never recorded cannot be
    grouped into an application at all. Each of them would otherwise arrive as a row
    claiming something is running and unreadable, which is a false alarm on a desktop
    where everything is fine.
    """
    monkeypatch.setattr(atspi, "application_pids", lambda: {})
    monkeypatch.setattr(atspi, "list_applications", lambda: [])
    monkeypatch.setattr(atspi, "_process_name", lambda pid: "")
    monkeypatch.setattr(
        x11,
        "toplevels",
        lambda: [
            x11.X11Window(xid=1, pid=0, title="orphan", wm_class="Something"),
            x11.X11Window(xid=2, pid=44, title="panel", wm_class="Panel", normal=False),
            x11.X11Window(xid=3, pid=55, title="splash", wm_class=""),
        ],
    )
    monkeypatch.setattr(server.loop, "call_on_loop", lambda fn, *a, **k: fn(*a))

    result = server._method_list_applications({"clientId": "cl-1"})
    assert result["invisibleApplications"] == []
