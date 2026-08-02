"""Toolchain smoke test.

Asserts the venv can reach the AT-SPI typelib and that the accessibility bus
answers. Assertions are on shape only — the number of running applications is a
property of whatever happens to be open, and must never be asserted on.
"""

import gi

gi.require_version("Atspi", "2.0")

from gi.repository import Atspi  # noqa: E402  (must follow require_version)


def test_atspi_desktop_is_reachable():
    desktop = Atspi.get_desktop(0)
    assert desktop is not None
    assert desktop.get_child_count() >= 0
