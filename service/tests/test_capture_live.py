"""Photographing one window, and proving it was the right one.

A capture is the one result this service produces that cannot be checked by reading
it. Text can be compared against the tree it came from; an image is just bytes, and
bytes that decode to a picture of the wrong window look exactly as convincing as
bytes that decode to a picture of the right one.

So the proof is dimensional. Three layers independently describe the window under
test — the accessibility tree reports its bounds, the display server reports the
geometry of the drawable, and the PNG header reports what was actually encoded — and
the capture is only trusted when the picture agrees with the window's own account of
its size. That is also how the invisible client-side-decoration margin was found:
before it was cropped, every GTK window photographed 122 pixels too wide.

The second thing proven here is the refusal. Pixels cannot be redacted, so a blocked
application must yield no image at all rather than a censored one.

Run against a real desktop.
"""

from __future__ import annotations

import base64
import os
import shutil

import pytest

from desktop_service import policy, server
from desktop_service.backends import atspi, capture, loop
from desktop_service.errors import DesktopError, ErrorCode

pytestmark = pytest.mark.skipif(
    not os.environ.get("DISPLAY") and not os.path.isdir("/tmp/.X11-unix"),
    reason="no display server to photograph anything on",
)

APP_BINARY = "gnome-text-editor"


@pytest.fixture(autouse=True)
def desktop_loop():
    loop.get_loop().start()


@pytest.fixture(autouse=True)
def unblocked():
    """No test here inherits another's policy, and none inherits the machine's."""
    policy.set_blocked_applications([])
    yield
    policy.set_blocked_applications(None)


@pytest.fixture()
def window():
    if not capture.available():
        pytest.skip(f"this desktop cannot capture: {capture.unavailable_reason()}")
    if not shutil.which(APP_BINARY):
        pytest.skip(f"{APP_BINARY} is not installed")
    for entry in server._method_list_windows({})["windows"]:
        if APP_BINARY in entry.get("applicationName", "").casefold().replace(" ", "-"):
            return entry
    for entry in server._method_list_windows({})["windows"]:
        if entry.get("title"):
            return entry
    pytest.skip("no window on this desktop to photograph")


def _bounds(window_id: str) -> tuple[int, int]:
    """What the accessibility layer says this window's size is.

    Deliberately a different source from the one the capture came through: a capture
    checked against the display server alone would be one layer agreeing with itself.
    """
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi

    def read() -> tuple[int, int]:
        accessible = atspi.find_window(window_id)
        extents = Atspi.Component.get_extents(accessible, Atspi.CoordType.SCREEN)
        return (extents.width, extents.height)

    return loop.call_on_loop(read, timeout=10.0)


def test_a_capture_is_a_png_of_the_window_that_was_named(window) -> None:
    result = server._method_capture_window({"windowId": window["id"], "clientId": "capture-test"})

    assert result["format"] == "png"
    image = base64.b64decode(result["image"])
    assert image[:8] == b"\x89PNG\r\n\x1a\n", "the result is not a PNG at all"
    assert result["width"] > 0 and result["height"] > 0

    expected = _bounds(window["id"])
    assert (result["width"], result["height"]) == expected, (
        "the picture is not the size the accessibility layer says this window is, so "
        f"something other than that window was photographed: {result['width']}x"
        f"{result['height']} against {expected[0]}x{expected[1]}"
    )


def test_the_invisible_shadow_margin_is_cropped_away(window) -> None:
    """A GTK window is captured larger than it is, and the difference is reported.

    Not cosmetic: the uncropped image is the number that disagreed with every other
    layer, and a caller comparing sizes to decide whether it got the right window
    would have concluded it had not.
    """
    result = server._method_capture_window({"windowId": window["id"]})
    if not result["frameCropped"]:
        pytest.skip("this window is server-decorated and reserves no shadow margin")

    assert result["capturedWidth"] > result["width"]
    assert result["capturedHeight"] > result["height"]


def test_scaling_only_ever_goes_down(window) -> None:
    full = server._method_capture_window({"windowId": window["id"]})
    small = server._method_capture_window({"windowId": window["id"], "maxWidth": 200})
    assert small["width"] <= 200
    assert small["width"] < full["width"]
    assert small["scaled"] is True

    # Asking for more than the window has does not invent any.
    huge = server._method_capture_window({"windowId": window["id"], "maxWidth": 4096})
    assert huge["width"] == full["width"]


def test_a_blocked_application_yields_no_pixels(window) -> None:
    """The refusal is the whole gate, because there is no partial version of it.

    A value can be redacted on the way out. An image cannot, so the only honest
    answer for a blocked application is no image — and the caller cannot
    distinguish a blocked application from one that was never there.
    """
    application = window["applicationName"]
    policy.set_blocked_applications([application])

    with pytest.raises(DesktopError) as raised:
        server._method_capture_window({"windowId": window["id"]})

    assert raised.value.code == ErrorCode.APPLICATION_NOT_FOUND
    assert application not in str(raised.value)


def test_the_blocklist_is_not_something_a_caller_can_widen(window) -> None:
    """Nothing in the request can turn a refusal into a capture.

    The schema has no parameter for it, which is the real guarantee; this asserts the
    guarantee rather than trusting that nobody adds one later. `confirm` and `clientId`
    are on every method by composition and grant nothing by themselves.
    """
    from desktop_service import protocol_generated

    params = protocol_generated.PARAMS_SCHEMA["captureWindow"]
    assert set(params["properties"]) == {"windowId", "maxWidth", "clientId", "confirm"}
    assert params["additionalProperties"] is False
    assert protocol_generated.OPERATION_CLASS["captureWindow"] == "observe"
