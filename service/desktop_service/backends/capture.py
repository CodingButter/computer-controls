"""The vision tier: pixels of one window, from the display server.

Capture is the recovery path, not the normal one. It exists for content the
accessibility layer genuinely cannot express — what is printed on an image, what
a canvas is drawing — and never as a shortcut around a widget that has a name and
an action. Nothing in this module returns coordinates, and no method anywhere
gains a coordinate parameter because captures exist.

Three facts decided the implementation, and all three were measured on this
machine rather than assumed.

**The obvious API is a dead end.** `org.gnome.Shell.Screenshot.ScreenshotWindow`
answers `AccessDenied` to callers that are not the GNOME UI, so the compositor
will not take a picture on this service's behalf on GNOME 46.

**X11 hands over a single window's pixels without asking the compositor.** `xwd`
against an X window id reads that window's own contents, so the user's other
windows are never in frame — this is not a screenshot with a crop applied to it,
which would be a very different privacy claim.

**A GTK window is bigger than it looks.** Client-side-decorated windows reserve an
invisible margin for their drop shadow, and the raw capture includes it: the text
editor captures as 822x642 while every other layer calls that window 700x520.
`_GTK_FRAME_EXTENTS` says exactly how wide that margin is, so cropping by it makes
the returned image's dimensions match the window's own reported bounds — which is
also how a caller can tell it was handed the right window rather than a screen.
"""

from __future__ import annotations

import base64
import shutil
import subprocess
from dataclasses import dataclass

from . import x11

BACKEND = "compositor"

_GTK_FRAME_EXTENTS = "_GTK_FRAME_EXTENTS"
_CAPTURE_TIMEOUT_SECONDS = 10.0

# A capture is an image, not a page of a photo album. The cap is generous enough for
# a 4K window and small enough that no single reply can carry a video frame budget.
MAX_WIDTH_CEILING = 4096


@dataclass(frozen=True)
class Capture:
    """One window's pixels, and an honest account of what was done to them."""

    png: bytes
    width: int
    height: int
    captured_width: int
    captured_height: int
    frame_cropped: bool
    scaled: bool

    def encoded(self) -> str:
        return base64.b64encode(self.png).decode("ascii")


def available() -> bool:
    return not unavailable_reason()


def unavailable_reason() -> str:
    """Why pixels cannot be produced, in the caller's terms rather than ours."""

    missing = [name for name in ("xwd", "ffmpeg") if shutil.which(name) is None]
    if missing:
        return f"no {' or '.join(missing)} on PATH: window capture needs both"
    if not x11.available():
        return x11.unavailable_reason()
    return ""


def _frame_margin(xid: int) -> tuple[int, int, int, int]:
    """The invisible shadow margin a client-side-decorated window reserves.

    Absent on server-decorated windows, which is not an error: they have no margin
    and their raw capture is already the window everybody else is talking about.
    """

    value = x11.window_property(xid, _GTK_FRAME_EXTENTS)
    if not isinstance(value, list) or len(value) != 4:
        return (0, 0, 0, 0)
    left, right, top, bottom = (int(v) for v in value)
    if min(left, right, top, bottom) < 0:
        return (0, 0, 0, 0)
    return (left, right, top, bottom)


def _filters(margin: tuple[int, int, int, int], max_width: int | None) -> str:
    left, right, top, bottom = margin
    stages = []
    if any(margin):
        stages.append(f"crop=iw-{left + right}:ih-{top + bottom}:{left}:{top}")
    if max_width:
        # Only ever downward: enlarging a capture invents detail that was not captured.
        stages.append(f"scale='min({max_width},iw)':-2:flags=lanczos")
    return ",".join(stages)


def capture(xid: int, max_width: int | None = None) -> Capture:
    """Read one window's pixels and hand back a PNG.

    Raises `OSError` with the tool's own message when the display server refuses,
    which is the normal answer for a window that has been unmapped or closed
    between the caller naming it and this call reaching the server.
    """

    raw = subprocess.run(
        ["xwd", "-id", str(xid), "-silent"],
        capture_output=True,
        timeout=_CAPTURE_TIMEOUT_SECONDS,
    )
    if raw.returncode != 0 or not raw.stdout:
        detail = raw.stderr.decode("utf-8", "replace").strip() or "xwd produced no image"
        raise OSError(detail)

    margin = _frame_margin(xid)
    filters = _filters(margin, max_width)
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "xwd_pipe", "-i", "pipe:0"]
    if filters:
        command += ["-vf", filters]
    command += ["-frames:v", "1", "-f", "image2", "-c:v", "png", "pipe:1"]

    encoded = subprocess.run(
        command, input=raw.stdout, capture_output=True, timeout=_CAPTURE_TIMEOUT_SECONDS
    )
    if encoded.returncode != 0 or not encoded.stdout:
        detail = encoded.stderr.decode("utf-8", "replace").strip() or "no image was encoded"
        raise OSError(detail)

    captured = _dimensions(raw.stdout)
    width, height = _png_dimensions(encoded.stdout)
    return Capture(
        png=encoded.stdout,
        width=width,
        height=height,
        captured_width=captured[0],
        captured_height=captured[1],
        frame_cropped=any(margin),
        scaled=bool(max_width) and width < captured[0] - margin[0] - margin[1],
    )


def _dimensions(xwd: bytes) -> tuple[int, int]:
    """Width and height as the X window dump header states them."""

    if len(xwd) < 32:
        return (0, 0)
    width = int.from_bytes(xwd[16:20], "big")
    height = int.from_bytes(xwd[20:24], "big")
    return (width, height)


def _png_dimensions(png: bytes) -> tuple[int, int]:
    """Width and height read out of the PNG header rather than trusted from the filter graph."""

    if len(png) < 24 or png[:8] != b"\x89PNG\r\n\x1a\n":
        return (0, 0)
    return (int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big"))
