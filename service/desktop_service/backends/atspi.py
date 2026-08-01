"""The AT-SPI2 backend, over `gi.repository.Atspi`.

Not `pyatspi` — it is not installed on this machine and is not a dependency.

Every function here must run on the GLib loop thread. Callers reach them through
`call_on_loop`, never directly.

Identity note. AT-SPI's own `get_id()` is not unique per window: on this machine
Chrome's three frames all report `32`, and the desktop-icon frames all report
`11`. The identity that *is* unique is the accessible's D-Bus address — the
owning application's bus name plus the object path. Every id this module hands
out is derived from that pair, which is why references survive across calls
without a lookup table.
"""

from __future__ import annotations

import hashlib
from typing import Any

import gi

gi.require_version("Atspi", "2.0")

from gi.repository import Atspi  # noqa: E402  (must follow require_version)

BACKEND_NAME = "atspi"

# Roles that count as a top-level window. Anything else appearing as a direct
# child of an application (Zoom parks stray labels there) is not a window.
WINDOW_ROLES = frozenset({"frame", "dialog", "window", "alert"})

# On X11, mutter re-parents client windows for decoration and publishes those
# frames as its own AT-SPI application. Its frames are duplicates of real client
# windows — reporting them would show the user two Discords.
FRAME_PROVIDER_APPS = frozenset({"mutter-x11-frames"})


def _short_id(prefix: str, *parts: str) -> str:
    digest = hashlib.sha1("\0".join(parts).encode("utf-8")).hexdigest()[:12]
    return f"{prefix}-{digest}"


def _bus_name(obj: Atspi.Accessible) -> str:
    app = getattr(obj, "app", None)
    bus = getattr(app, "bus_name", None) if app is not None else None
    return bus or ""


def _object_address(obj: Atspi.Accessible) -> tuple[str, str]:
    return _bus_name(obj), getattr(obj, "path", "") or ""


def application_id(app: Atspi.Accessible) -> str:
    bus, _ = _object_address(app)
    return _short_id("app", bus)


def window_id(window: Atspi.Accessible) -> str:
    bus, path = _object_address(window)
    return _short_id("win", bus, path)


def _safe(fn, default=None):
    """AT-SPI calls fail in ordinary operation — an application can exit between
    the enumeration and the question. A dead peer is not an error worth aborting
    a whole listing for."""
    try:
        return fn()
    except Exception:  # noqa: BLE001 - a dead or degraded peer, not our bug
        return default


def probe_desktop() -> dict[str, Any]:
    """Decide whether the accessibility bridge actually works by using it.

    The `toolkit-accessibility` gsetting reads `false` on this machine while the
    bridge is fully functional, so it is not consulted anywhere.
    """
    try:
        desktop = Atspi.get_desktop(0)
        if desktop is None:
            return {"available": False, "reason": "Atspi.get_desktop(0) returned None"}
        count = desktop.get_child_count()
    except Exception as exc:  # noqa: BLE001 - the probe's whole job is to catch this
        return {"available": False, "reason": f"{type(exc).__name__}: {exc}"}
    if count <= 0:
        return {
            "available": False,
            "reason": "the accessibility bus is reachable but exposes no applications",
        }
    return {"available": True, "applicationCount": count}


def _iter_desktop_apps():
    desktop = Atspi.get_desktop(0)
    if desktop is None:
        return
    for index in range(desktop.get_child_count()):
        app = _safe(lambda i=index: desktop.get_child_at_index(i))
        if app is None:
            continue
        yield app


def _window_states(window: Atspi.Accessible) -> list[str]:
    state_set = _safe(window.get_state_set)
    if state_set is None:
        return []
    states = _safe(state_set.get_states, [])
    return sorted(s.value_nick for s in (states or []))


def list_applications() -> list[dict[str, Any]]:
    applications: list[dict[str, Any]] = []
    for app in _iter_desktop_apps():
        name = _safe(app.get_name, "") or ""
        if name in FRAME_PROVIDER_APPS:
            continue
        applications.append(
            {
                "id": application_id(app),
                "name": name,
                "pid": _safe(app.get_process_id, -1),
                "toolkit": {
                    "name": _safe(app.get_toolkit_name, "") or "",
                    "version": _safe(app.get_toolkit_version, "") or "",
                },
                "windowCount": len(_windows_of(app)),
                "backend": BACKEND_NAME,
            }
        )
    return applications


def _windows_of(app: Atspi.Accessible) -> list[Atspi.Accessible]:
    windows: list[Atspi.Accessible] = []
    count = _safe(app.get_child_count, 0) or 0
    for index in range(count):
        child = _safe(lambda i=index: app.get_child_at_index(i))
        if child is None:
            continue
        role = _safe(child.get_role_name, "") or ""
        if role in WINDOW_ROLES:
            windows.append(child)
    return windows


def list_windows(application_id_filter: str | None = None) -> list[dict[str, Any]]:
    windows: list[dict[str, Any]] = []
    for app in _iter_desktop_apps():
        app_name = _safe(app.get_name, "") or ""
        if app_name in FRAME_PROVIDER_APPS:
            continue
        app_id = application_id(app)
        if application_id_filter and app_id != application_id_filter:
            continue
        for window in _windows_of(app):
            states = _window_states(window)
            windows.append(
                {
                    "id": window_id(window),
                    "applicationId": app_id,
                    "applicationName": app_name,
                    "title": _safe(window.get_name, "") or "",
                    "role": _safe(window.get_role_name, "") or "",
                    "active": "active" in states,
                    "states": states,
                    "backend": BACKEND_NAME,
                }
            )
    return windows


def find_application(app_id: str) -> Atspi.Accessible | None:
    for app in _iter_desktop_apps():
        if application_id(app) == app_id:
            return app
    return None
