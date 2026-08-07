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
from typing import Any, Callable


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


#: Raw input as a general driver is refused, not missing, so its reason is a
#: constant rather than a probe result. It used to be assembled from `/dev/uinput`
#: existence and writability checks and `xdotool`/`ydotool`/`wmctrl` lookups,
#: which was wrong twice over: a design refusal does not turn on which tools are
#: installed, and none of those tools is how anything in this build synthesizes a
#: key. The second error was the costly one — it left this entry reading as the
#: last word on synthetic keyboard input, when the keystroke tier that does exist
#: uses a different mechanism entirely and is reported somewhere else.
_RAW_INPUT_REASON = (
    "raw input as a general driver is out of scope for this build by design: the "
    "rule is a semantic desktop, never a remote shell, and a driver types into "
    "whatever holds focus, including a window the user walled off. Synthetic "
    "keystrokes addressed to a named element are a different thing and are "
    "implemented: see typeKeystrokes, reported under this report's accessibility "
    "tier as its 'keystrokes' detail."
)

#: What the keystroke tier is, carried in the report whether or not this session
#: can run it. A caller that finds only `keystrokes: false` learns that the tier
#: is unavailable; a caller that also reads this learns that it exists at all,
#: which is the fact the report used to withhold entirely.
_KEYSTROKE_NOTE = (
    "typeKeystrokes types with synthetic key events, for a field that is editable "
    "and readable but offers no interface to write through. It is an escalation "
    "addressed to a named element rather than a general input driver: it passes "
    "the consent ceiling, the holds registry, the presence gate and per-character "
    "pacing, and what landed is read back and compared exactly as typeText's is."
)


def _keystroke_reason(accessibility: dict[str, Any], display_server: str) -> str | None:
    """Why this session cannot synthesize keystrokes, or None when it can.

    The dependencies are the tier's real ones, which are not the ones the
    raw-input entry used to probe for. `typeKeystrokes` synthesizes through
    `Atspi.generate_keyboard_event` on the accessibility bus, and the modifier it
    holds down to clear a field is an X11 hardware keycode
    (`backends/atspi.py:1026-1033`). So: the bus, and an X11 session.

    Nothing here presses a key to find out. A probe that proved synthesis by
    synthesizing would type a character into whatever the person at this desktop
    is doing, which is too high a price for an answer these two inputs already
    give.
    """
    if not accessibility.get("available"):
        return (
            "keystroke synthesis goes through the accessibility bus, and the bus is "
            f"unavailable: {accessibility.get('reason')}"
        )
    if display_server != "x11":
        return (
            "keystroke synthesis needs an X11 session: the keys it holds down are "
            "X11 hardware keycodes, and this session's display server is "
            f"{display_server!r}"
        )
    return None


#: What "browser accessibility" means, carried whether or not the condition is met.
#: A caller that finds only `browserAccessibility: false` learns that something is off
#: and has no idea what would turn it on — the same mistake the keystroke entry made
#: before it started carrying its own note.
_BROWSER_ACCESSIBILITY_NOTE = (
    "Chromium-family browsers build no accessibility tree until an assistive client "
    "announces itself on the session, so a browser can be running, visible and "
    "completely unreadable — it appears under listApplications' invisibleApplications "
    "rather than as an empty tree. This service will not announce one for you: the "
    "switch that does it starts the screen reader on this desktop, and a person would "
    "be spoken to because an agent wanted to read a page. Two things satisfy the "
    "condition without this service touching anything: run your own assistive client "
    "(a screen reader, or any AT that registers on the accessibility bus), or start "
    "the browser with --force-renderer-accessibility."
)


def _browser_accessibility(status: dict[str, Any]) -> tuple[bool, str | None]:
    """Whether a browser on this session would build a tree, and why not when it would not.

    Reported as a condition, never as a measurement of a particular browser. Whether
    any given browser actually answers is what walking it proves, and this report has
    never claimed to have walked anything.
    """
    if not status.get("available"):
        return False, (
            "whether an assistive client has announced itself could not be read: "
            f"{status.get('reason')}"
        )
    if status.get("isEnabled") or status.get("screenReaderEnabled"):
        return True, None
    return False, (
        "no assistive client has announced itself on this session "
        "(org.a11y.Status reports IsEnabled false and ScreenReaderEnabled false), so "
        "Chromium-family browsers are building no accessibility tree"
    )


def build_report(
    probe_accessibility: Callable[[], dict[str, Any]],
    probe_capture: Callable[[], str],
    session_token: str,
    observation_mode: str,
    discover_session: Callable[[], dict[str, str]] | None = None,
    probe_assistive_status: Callable[[], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    session = {"token": session_token, **_detect_session(discover_session)}
    accessibility = probe_accessibility()
    # The empty string means "nothing stands in the way", so availability and its
    # reason come from one probe and cannot disagree with each other.
    capture_reason = probe_capture()
    keystroke_reason = _keystroke_reason(accessibility, session["displayServer"])
    browser_ok, browser_reason = _browser_accessibility(
        probe_assistive_status() if probe_assistive_status else {"available": False, "reason": "not probed"}
    )

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
                # Reported here rather than as a tier of its own, for the same
                # reason window capture and OCR sit inside the vision tier: this
                # is a capability of the accessibility bus, reached through the
                # same connection the tree is read over. Its own tier id would
                # also land it in `recommendedBackends`, and a call documented as
                # an escalation and never a fallback has no business being
                # recommended to anybody.
                "keystrokes": keystroke_reason is None,
                "keystrokesReason": keystroke_reason,
                "keystrokesNote": _KEYSTROKE_NOTE,
                # A setup condition, reported in the same place as the tier it
                # conditions. The bus can be perfectly healthy while the one
                # application the caller was sent to use has nothing on it.
                "browserAccessibility": browser_ok,
                "browserAccessibilityReason": browser_reason,
                "browserAccessibilityNote": _BROWSER_ACCESSIBILITY_NOTE,
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
            },
        },
        {
            "id": "raw-input",
            "name": "Synthetic pointer and keyboard input as a general driver",
            "available": False,
            "reason": _RAW_INPUT_REASON,
        },
    ]

    recommended = [t["id"] for t in tiers if t["available"]]

    return {
        "session": session,
        "tiers": tiers,
        "recommendedBackends": recommended,
        "observationMode": observation_mode,
    }
