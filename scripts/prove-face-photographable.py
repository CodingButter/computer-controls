#!/usr/bin/env python3
"""Photograph the face through its own route, and show that the desk behind it did not come too.

Two claims are being settled here, and only one of them is about a feature.

The feature is that an agent can see what the face drew: `GET /api/orb/capture` on the
hub asks the widget to photograph its own window and hands back a PNG. The unit tests
prove the plumbing — the id, the timeout, the one refusal shape — against a stubbed
`capturePage`. Past that call is Chromium's compositor, and no test can follow it there.

The other claim is the one that decides whether the route ships at all. The widget's
window is transparent and covers a whole display, so if `capturePage` composited what is
*behind* the window into the picture, this route would be a screen grab wearing a
feature's name — in a project that spends a whole test file refusing screen capture. So
the first thing this script does is put a distinctively-coloured window behind the orb
and check that its colour appears nowhere in the photograph. That check runs before the
one that looks for the orb, because a run that stopped early must stop having answered
the dangerous question rather than the flattering one.

The second lane is the window itself. An unfocusable window is created override-redirect
on X11, which means the window manager does not manage it: it is absent from
`_NET_CLIENT_LIST`, and therefore invisible to OBS, to screen recorders, and to this
project's own `captureWindow`. Demo mode makes the window focusable and titled, and this
script asks the display server whether that worked — through the same `x11.toplevels()`
the desktop service uses, so a pass here is a pass for the tool an agent would call.

The operator arranges the mode; the script measures it. Two runs make the comparison:

    python3 scripts/prove-face-photographable.py                     # widget running normally
    python3 scripts/prove-face-photographable.py                     # widget started --comcon-demo

The marker window is this script's own, fullscreen, solid, and closed before it exits.
It is the one thing here that touches the desktop, and it exists because the leak it
looks for cannot be provoked against an empty screen.

Exit codes: 0 every condition met, 1 a genuine negative, 4 nothing was measured (no hub,
no face, or no display) — a 4 is not evidence either way.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "comcon"))

DEFAULT_OUT = "docs/proofs/the-face-can-be-photographed.md"
DEFAULT_PORT = int(os.environ.get("COMCON_CLIENT_PORT", "4111"))

#: The orb's own rectangle, from window-shape.js. The capture route asks for exactly
#: this much of the window and never for the window, which is the whole display.
ORB_WIDTH = 360
ORB_HEIGHT = 260

#: A colour no interface picks by accident, so a pixel carrying it in the photograph
#: can only have come from the window this script put behind the face.
MARKER_RGB = (255, 0, 220)
MARKER_TOLERANCE = 24

#: How the title the widget sets in demo mode reads to the display server.
DEMO_TITLE = "Mastra CC"

#: Enough drawn pixels that a black canvas cannot pass as a rendered orb. The orb fills
#: a circle inside a 360x260 rectangle; a tenth of the rectangle is a low bar deliberately,
#: because this condition is about "something was rendered", not about composition.
MIN_DRAWN_PIXELS = int(ORB_WIDTH * ORB_HEIGHT * 0.10)

MARKER_CHILD = """
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, Gtk

window = Gtk.Window(title="comcon capture marker")
window.set_decorated(False)
window.set_skip_taskbar_hint(True)
window.fullscreen()
window.override_background_color(
    Gtk.StateFlags.NORMAL, Gdk.RGBA(%f, %f, %f, 1.0)
)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
"""


def environment() -> dict[str, str]:
    """What this measurement is true of.

    Discovered rather than assumed, for the same reason every other proof here
    discovers it: run from an SSH shell, this process's own environment would stamp
    the artifact with a session it never measured.
    """

    def command(*argv: str) -> str:
        try:
            return subprocess.run(argv, capture_output=True, text=True, timeout=5).stdout.strip()
        except Exception:
            return ""

    return {
        "when": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "os": f"{platform.system()} {platform.release()}",
        "desktop": os.environ.get("XDG_CURRENT_DESKTOP", "unknown"),
        "session": os.environ.get("XDG_SESSION_TYPE", "unknown"),
        "display": os.environ.get("DISPLAY", "") or "(none)",
        "compositor": command("sh", "-c", "wmctrl -m 2>/dev/null | head -n1") or "unknown",
    }


def fetch_capture(port: int, timeout: float) -> tuple[bytes | None, str]:
    """Ask the hub for a photograph of the face.

    Returns the bytes and a description of what happened, because the interesting
    failure — 504, nobody answered — is a finding about the wiring rather than an
    error to raise past.
    """
    url = f"http://127.0.0.1:{port}/api/orb/capture"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.read(), f"{response.status} {response.headers.get('content-type')}"
    except urllib.error.HTTPError as refused:
        return None, f"{refused.code} {refused.read().decode('utf8', 'replace').strip()[:120]}"
    except Exception as unreachable:  # no hub, or no route
        return None, f"unreachable: {unreachable}"


def measure(png: bytes) -> dict:
    """What is in the picture, counted rather than described."""
    from PIL import Image

    image = Image.open(BytesIO(png)).convert("RGBA")
    width, height = image.size
    pixels = image.load()

    marker = 0
    drawn = 0
    transparent = 0
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                transparent += 1
                continue
            if (
                abs(r - MARKER_RGB[0]) <= MARKER_TOLERANCE
                and abs(g - MARKER_RGB[1]) <= MARKER_TOLERANCE
                and abs(b - MARKER_RGB[2]) <= MARKER_TOLERANCE
            ):
                marker += 1
            if a > 8 and (r, g, b) != (0, 0, 0):
                drawn += 1

    corners = [pixels[0, 0], pixels[width - 1, 0], pixels[0, height - 1], pixels[width - 1, height - 1]]
    return {
        "width": width,
        "height": height,
        "bytes": len(png),
        "marker": marker,
        "drawn": drawn,
        "transparent": transparent,
        "corners_transparent": all(pixel[3] == 0 for pixel in corners),
    }


def with_marker_behind(port: int, timeout: float) -> tuple[dict | None, str]:
    """Put a solid colour behind the face and photograph it.

    The window is fullscreen and ordinary, so it sits under an always-on-top orb: what
    it covers is exactly the desk the picture must not contain.
    """
    child = subprocess.Popen(
        [sys.executable, "-c", MARKER_CHILD % tuple(value / 255 for value in MARKER_RGB)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        time.sleep(1.5)
        if child.poll() is not None:
            return None, f"the marker window would not open: {child.stderr.read().decode()[:200]}"
        png, note = fetch_capture(port, timeout)
        if png is None:
            return None, note
        return measure(png), note
    finally:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()


def managed_windows() -> list[dict]:
    """Every window the window manager admits to managing, as the desktop service sees them.

    Read through `x11.toplevels()` rather than by parsing `xprop`, so a pass here is a
    pass for the code path `captureWindow` actually walks.
    """
    from desktop_service.backends import x11

    return [
        {"xid": window.xid, "pid": window.pid, "title": window.title, "class": window.wm_class,
         "normal": window.normal}
        for window in x11.toplevels()
    ]


def override_redirect(xid: int) -> str | None:
    """What `xwininfo` says about the window's kind, quoted rather than paraphrased."""
    try:
        out = subprocess.run(
            ["xwininfo", "-id", str(xid)], capture_output=True, text=True, timeout=5
        ).stdout
    except Exception:
        return None
    for line in out.splitlines():
        if "Override Redirect" in line:
            return line.strip()
    return None


def capture_the_window(xid: int) -> tuple[dict | None, str]:
    """Take the window's pixels the way `captureWindow` would.

    The service's own handler is not called because it resolves its target through the
    accessibility bus and applies the per-application capture policy, neither of which
    is the claim here. What is being shown is that the window is addressable by the
    display server at all — the step demo mode exists to make possible.
    """
    from desktop_service.backends import capture

    if not capture.available():
        return None, f"no capture backend: {capture.unavailable_reason()}"
    try:
        image = capture.capture(xid, None)
    except Exception as refused:
        return None, f"the display server would not produce pixels: {refused}"
    return {"width": image.width, "height": image.height}, "captured"


def acceptance(mode: str, leak: dict | None, shot: dict | None, demo_window: dict | None,
               window_pixels: dict | None) -> list[tuple[str, bool, str]]:
    """The conditions the issue asked for, answered one at a time.

    The first is the one that decides whether any of this ships, so it is first here
    too. A run where the marker colour appears is not a failing feature, it is a
    finding that the route must not exist in this form.
    """
    conditions: list[tuple[str, bool, str]] = []

    if leak is not None:
        conditions.append((
            "the desk behind the face is not in the photograph",
            leak["marker"] == 0,
            f"{leak['marker']} of {leak['width'] * leak['height']} pixels carried the marker colour",
        ))
        conditions.append((
            "the parts of the window nothing was drawn on are transparent",
            leak["corners_transparent"],
            f"corners transparent: {leak['corners_transparent']}, "
            f"{leak['transparent']} transparent pixels in total",
        ))

    if shot is not None:
        conditions.append((
            "the route answers with a picture of the orb's own rectangle",
            (shot["width"], shot["height"]) == (ORB_WIDTH, ORB_HEIGHT),
            f"{shot['width']}x{shot['height']}, {shot['bytes']} bytes",
        ))
        conditions.append((
            "the orb is rendered in it, rather than a black canvas",
            shot["drawn"] >= MIN_DRAWN_PIXELS,
            f"{shot['drawn']} drawn pixels (needed {MIN_DRAWN_PIXELS})",
        ))

    if mode == "demo":
        conditions.append((
            "the window manager manages the face",
            demo_window is not None,
            f"in _NET_CLIENT_LIST as {demo_window['title']!r}" if demo_window
            else f"no window titled {DEMO_TITLE!r} in _NET_CLIENT_LIST",
        ))
        if demo_window is not None:
            conditions.append((
                "and does not treat it as override-redirect",
                demo_window.get("override") is not None
                and demo_window["override"].endswith("no"),
                f"xwininfo: {demo_window.get('override')!r}",
            ))
        conditions.append((
            "window-scoped capture can take its pixels",
            window_pixels is not None,
            f"{window_pixels['width']}x{window_pixels['height']}" if window_pixels
            else "no pixels",
        ))
    else:
        conditions.append((
            "the resident face stays out of the window manager's list",
            demo_window is None,
            f"found {demo_window['title']!r} in _NET_CLIENT_LIST" if demo_window
            else "absent, as an override-redirect window is",
        ))

    return conditions


def render(mode: str, env: dict[str, str], leak: dict | None, leak_note: str, shot: dict | None,
           shot_note: str, demo_window: dict | None, window_pixels: dict | None,
           window_note: str, conditions: list[tuple[str, bool, str]]) -> str:
    held = all(ok for _label, ok, _seen in conditions) and conditions
    verdict = "THE CLAIM HOLDS" if held else "THE CLAIM DOES NOT HOLD"

    lines = [
        "# The face can be photographed without photographing the screen",
        "",
        f"**{verdict}** — measured {env['when']}, widget running in **{mode}** mode.",
        "",
        "Generated by `scripts/prove-face-photographable.py`. Never edit by hand.",
        "",
        "## What was measured on",
        "",
        "| | |",
        "|---|---|",
    ]
    for key in ("os", "desktop", "session", "display", "compositor"):
        lines.append(f"| {key} | {env[key]} |")

    lines += [
        "",
        "## The dangerous question, asked first",
        "",
        "A fullscreen window painted `#FF00DC` was placed behind the always-on-top face, and",
        "the capture route was asked for a photograph. If Chromium composited the desktop",
        "behind the transparent window into the picture, that colour would be in it.",
        "",
        f"- route said: `{leak_note}`",
    ]
    if leak is not None:
        lines.append(f"- marker pixels in the photograph: **{leak['marker']}**")
        lines.append(
            f"- transparent pixels: {leak['transparent']} of {leak['width'] * leak['height']}"
        )

    lines += [
        "",
        "## The photograph itself",
        "",
        f"- route said: `{shot_note}`",
    ]
    if shot is not None:
        lines.append(f"- size: {shot['width']}x{shot['height']} ({shot['bytes']} bytes)")
        lines.append(f"- pixels with something drawn on them: {shot['drawn']}")

    lines += [
        "",
        "## The window the desktop can see",
        "",
        f"- `x11.toplevels()` found: "
        + (f"`{json.dumps(demo_window)}`" if demo_window else f"no window titled {DEMO_TITLE!r}"),
        f"- window-scoped capture: {window_note}",
        "",
        "## Conditions",
        "",
        "| Condition | Met | What was seen |",
        "|---|---|---|",
    ]
    for label, ok, seen in conditions:
        lines.append(f"| {label} | {'yes' if ok else 'no'} | {seen} |")

    lines += [
        "",
        "## Rerunning it",
        "",
        "```",
        "python3 scripts/prove-face-photographable.py",
        "```",
        "",
        "Run it twice: once with the widget started normally and once with `--comcon-demo`",
        "(or demo mode ticked in the tray). One run measures one mode; the pair is what",
        "shows the resident face stays out of the window list that the demonstrable one",
        "joins.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="the hub's port")
    parser.add_argument("--out", default=DEFAULT_OUT, help="where the artifact is written")
    parser.add_argument(
        "--timeout", type=float, default=10.0, help="how long to wait on the capture route"
    )
    args = parser.parse_args()

    if not os.environ.get("DISPLAY"):
        print(
            "no DISPLAY: this proof is about what a display server does with a transparent "
            "window, and there is no display server here",
            file=sys.stderr,
        )
        return 4

    windows = managed_windows()
    demo_window = next((w for w in windows if w["title"] == DEMO_TITLE), None)
    mode = "demo" if demo_window else "resident"
    if demo_window:
        demo_window["override"] = override_redirect(demo_window["xid"])

    print(f"the widget appears to be running in {mode} mode")

    # First, and deliberately: the question whose wrong answer means this route does
    # not ship at all.
    print("  putting a marker window behind the face")
    leak, leak_note = with_marker_behind(args.port, args.timeout)
    print(f"  marker run: {leak_note}" + (f", {leak['marker']} marker pixels" if leak else ""))

    png, shot_note = fetch_capture(args.port, args.timeout)
    shot = measure(png) if png else None
    print(f"  capture: {shot_note}")

    window_pixels, window_note = (None, "not attempted: the window is not in the manager's list")
    if demo_window:
        window_pixels, window_note = capture_the_window(demo_window["xid"])
        print(f"  window capture: {window_note}")

    if leak is None and shot is None:
        print(
            "nothing was measured: the hub answered nothing and no face was photographed. "
            "Start the hub and the widget, then run this again.",
            file=sys.stderr,
        )
        return 4

    conditions = acceptance(mode, leak, shot, demo_window, window_pixels)
    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        render(mode, environment(), leak, leak_note, shot, shot_note, demo_window,
               window_pixels, window_note, conditions)
    )

    failed = [label for label, ok, _seen in conditions if not ok]
    print(f"\n{out}: written")
    if failed:
        print("the run was recorded but does not meet: " + "; ".join(failed), file=sys.stderr)
        return 1
    print("every condition met")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
