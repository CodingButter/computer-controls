"""Naming a window the accessibility layer never mentioned.

An application that never joins the accessibility bus is still a window on the display
server, and the only names that window carries are the ones X11 puts on it. Those names
decide two things that matter: whether the application can be reported at all, and
whether the consent ceiling can judge it. Both go wrong quietly if the parsing is wrong —
a mis-read `WM_CLASS` produces a row named after the wrong application, and a row named
after the wrong application is a row the ceiling checks against the wrong entry.

These are parsing tests. They need no display, which is the point: the properties are
bytes and atom ids by the time this code sees them, and everything upstream of that is
libX11's business.
"""

from __future__ import annotations

from desktop_service.backends import x11


def test_the_class_is_preferred_over_the_instance():
    # WM_CLASS is instance then class. The class is the name a desktop's own
    # configuration — and therefore the consent ceiling — is written in.
    assert x11._wm_class(b"google-chrome\0Google-chrome\0") == "Google-chrome"


def test_an_application_that_sets_only_one_name_is_still_named():
    assert x11._wm_class(b"vesktop\0") == "vesktop"
    assert x11._wm_class(b"vesktop") == "vesktop"


def test_a_window_carrying_no_class_has_no_name():
    assert x11._wm_class(None) == ""
    assert x11._wm_class(b"") == ""
    assert x11._wm_class(b"\0\0") == ""
    # A list means the property came back as atoms, which WM_CLASS never is.
    assert x11._wm_class([1, 2]) == ""


def test_undecodable_bytes_still_produce_a_name():
    # Never raises: a window with a broken property is the normal state of a desktop,
    # and an exception here would take out the whole enumeration.
    assert x11._wm_class(b"\xff\xfe\0Chrome\0") == "Chrome"


def test_a_window_that_declares_no_type_counts_as_normal():
    # The omission is what most windows do, and every window manager reads it as normal.
    assert x11._is_normal(None, 42) is True
    assert x11._is_normal([], 42) is True


def test_a_window_declares_the_type_it_is():
    assert x11._is_normal([42], 42) is True
    assert x11._is_normal([7], 42) is False
    # Several types, one of which is normal — a dialog that also declares normal.
    assert x11._is_normal([7, 42], 42) is True
