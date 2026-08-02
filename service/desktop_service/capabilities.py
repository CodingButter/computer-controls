"""Session detection and honest capability reporting.

Two rules shape this module.

First, **probe, never trust a setting**. The `toolkit-accessibility` gsetting
reads `false` on this machine while the accessibility bridge is fully functional,
so availability is decided by enumerating the desktop and seeing what comes back.
The probe is injected rather than imported, because everything that touches a
toolkit binding lives under `backends/`.

Second, **a tier that is not implemented is reported as unavailable with a
reason**, never omitted and never claimed. A caller reading this report can tell
the difference between "this desktop cannot do that" and "this build does not do
that yet", which are very different facts.
"""

from __future__ import annotations

import os
import shutil
from typing import Any, Callable

from . import policy


def _detect_session(discover: Callable[[], dict[str, str]] | None = None) -> dict[str, Any]:
    """Describe the session, preferring our own environment and falling back to
    the desktop's.

    Our own environment wins when it has an answer: a caller who set `DISPLAY`
    deliberately is not to be second-guessed. `discover` is only consulted for
    what is missing, which is the common case for a daemon started from a shell
    that never belonged to the desktop it drives.
    """

    borrowed = discover() if discover is not None else {}

    def read(name: str) -> str:
        return os.environ.get(name, "") or borrowed.get(name, "")

    session_type = read("XDG_SESSION_TYPE") or "unknown"
    desktop = read("XDG_CURRENT_DESKTOP") or "unknown"
    wayland_display = read("WAYLAND_DISPLAY")
    display = read("DISPLAY")

    # `tty` is the one inherited value worth overruling: it is what every shell,
    # tmux pane and systemd unit carries, and it says nothing about the desktop
    # being driven. Every other explicit answer stands even when discovery
    # disagrees with it.
    if session_type == "tty" and borrowed.get("XDG_SESSION_TYPE"):
        session_type = borrowed["XDG_SESSION_TYPE"]

    borrowed_desktop = not os.environ.get("XDG_CURRENT_DESKTOP") and bool(
        borrowed.get("XDG_CURRENT_DESKTOP")
    )

    if session_type == "x11" or (display and not wayland_display):
        display_server = "x11"
    elif wayland_display:
        display_server = "wayland"
    else:
        display_server = "unknown"

    compositor = "unknown"
    lowered = desktop.lower()
    if "gnome" in lowered:
        compositor = "mutter"
    elif "kde" in lowered or "plasma" in lowered:
        compositor = "kwin"
    elif "sway" in lowered:
        compositor = "sway"

    return {
        "displayServer": display_server,
        "desktopEnvironment": desktop,
        "compositor": compositor,
        "compositorSource": (
            "inferred from XDG_CURRENT_DESKTOP"
            + (" borrowed from the session's own processes" if borrowed_desktop else "")
        ),
        "display": display,
        "waylandDisplay": wayland_display,
    }


def _raw_input_reason() -> str:
    reasons = []
    if not os.path.exists("/dev/uinput"):
        reasons.append("/dev/uinput does not exist")
    elif not os.access("/dev/uinput", os.W_OK):
        reasons.append("/dev/uinput is not writable by this user")
    missing = [b for b in ("xdotool", "ydotool", "wmctrl") if shutil.which(b) is None]
    if missing:
        reasons.append(f"no {', '.join(missing)} on PATH")
    reasons.append("raw input is out of scope for this build by design")
    return "; ".join(reasons)


def build_report(
    probe_accessibility: Callable[[], dict[str, Any]],
    probe_capture: Callable[[], str],
    session_token: str,
    observation_mode: str,
    discover_session: Callable[[], dict[str, str]] | None = None,
) -> dict[str, Any]:
    session = {"token": session_token, **_detect_session(discover_session)}
    accessibility = probe_accessibility()
    # The empty string means "nothing stands in the way", so availability and its
    # reason come from one probe and cannot disagree with each other.
    capture_reason = probe_capture()

    tiers = [
        {
            "id": "app-native",
            "name": "Application-native integrations",
            "available": False,
            "reason": (
                "deferred by scope: no browser DevTools, Firefox remote protocol or "
                "application D-Bus adapter is implemented in this build"
            ),
        },
        {
            "id": "accessibility",
            "name": "AT-SPI2 accessibility tree",
            "available": bool(accessibility.get("available")),
            "reason": accessibility.get("reason"),
            "detail": {
                "probe": "enumerated the AT-SPI desktop",
                "note": (
                    "the toolkit-accessibility gsetting is deliberately not consulted; "
                    "it reads false on machines where the bridge works"
                ),
                "applicationCount": accessibility.get("applicationCount"),
            },
        },
        {
            "id": "compositor",
            "name": "Display server and compositor window management",
            "available": session["displayServer"] == "x11",
            "reason": (
                None
                if session["displayServer"] == "x11"
                else f"session display server is {session['displayServer']!r}: X11 window "
                "management is unavailable and the Wayland portal path is deferred by scope"
            ),
            "detail": {
                "x11": session["displayServer"] == "x11",
                "waylandPortals": False,
                "waylandPortalsReason": (
                    "deferred by scope: portal-based control is not implemented in this build"
                ),
            },
        },
        {
            "id": "vision",
            "name": "Window capture, vision and OCR",
            "available": not capture_reason,
            "reason": capture_reason or None,
            "detail": {
                "windowCapture": not capture_reason,
                "screenCapture": False,
                "screenCaptureReason": (
                    "out of scope by design: captures are addressed by window id, so a "
                    "caller can never ask for the screen and never receive somebody "
                    "else's window in the frame"
                ),
                "ocr": False,
                "ocrReason": "deferred by scope: no OCR engine is bundled with this build",
                "blockedApplications": sorted(policy.blocked_applications()),
            },
        },
        {
            "id": "raw-input",
            "name": "Synthetic pointer and keyboard input",
            "available": False,
            "reason": _raw_input_reason(),
        },
    ]

    recommended = [t["id"] for t in tiers if t["available"]]

    return {
        "session": session,
        "tiers": tiers,
        "recommendedBackends": recommended,
        "observationMode": observation_mode,
    }
