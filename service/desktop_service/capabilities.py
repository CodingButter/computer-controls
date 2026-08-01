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


def _detect_session() -> dict[str, Any]:
    session_type = os.environ.get("XDG_SESSION_TYPE", "") or "unknown"
    desktop = os.environ.get("XDG_CURRENT_DESKTOP", "") or "unknown"
    wayland_display = os.environ.get("WAYLAND_DISPLAY", "")
    display = os.environ.get("DISPLAY", "")

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
        "compositorSource": "inferred from XDG_CURRENT_DESKTOP",
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
    session_token: str,
    observation_mode: str,
) -> dict[str, Any]:
    session = {"token": session_token, **_detect_session()}
    accessibility = probe_accessibility()

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
            "name": "Screen capture, vision and OCR",
            "available": False,
            "reason": "out of scope: this build has no screen capture backend at all",
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
