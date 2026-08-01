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

from .. import model, registry  # noqa: E402

BACKEND_NAME = "atspi"

# Roles whose text content is worth carrying. Everything else reports no value
# rather than a truncated slab of document.
TEXT_VALUE_ROLES = frozenset(
    {"entry", "text", "password text", "spin button", "combo box", "document text"}
)

# A value is a label, not a payload. Anything longer is the caller's business to
# request deliberately, not something an inspection ships by accident.
MAX_VALUE_CHARS = 512

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
                "name": model.egress_value(
                    name, field=model.APPLICATION_NAME, role="application"
                ),
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
                    "applicationName": model.egress_value(
                        app_name, field=model.APPLICATION_NAME, role="application"
                    ),
                    "title": model.egress_value(
                        _safe(window.get_name, "") or "",
                        field=model.TITLE,
                        role=_safe(window.get_role_name, "") or "",
                        states=states,
                        element_id=window_id(window),
                    ),
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


# --- Element identity, references, and the live object table -----------------
#
# AT-SPI has no constructor that turns a D-Bus address back into an accessible:
# `Atspi.Accessible` exposes no `new_from_path` and no reference lookup. So an
# address is enough to *name* an element uniquely but not to *reach* it again.
# The backend therefore keeps the live objects it has handed out, keyed by the
# id derived from their address. The registry above never sees an accessible —
# it passes the reference dict back here and this module does the touching,
# which is what keeps `gi` inside `backends/`.

_objects: dict[str, Atspi.Accessible] = {}


def element_id(obj: Atspi.Accessible) -> str:
    bus, path = _object_address(obj)
    return _short_id("el", bus, path)


def _reference(obj: Atspi.Accessible, obj_id: str) -> dict[str, Any]:
    bus, path = _object_address(obj)
    return {"backend": BACKEND_NAME, "id": obj_id, "busName": bus, "path": path}


def _remember(obj: Atspi.Accessible, obj_id: str) -> None:
    _objects[obj_id] = obj


def lookup(obj_id: str) -> Atspi.Accessible | None:
    return _objects.get(obj_id)


def forget_all() -> None:
    """Drop the object table. Used by tests; a real session keeps it."""
    _objects.clear()


def _states_of(obj: Atspi.Accessible) -> list[str]:
    state_set = _safe(obj.get_state_set)
    if state_set is None:
        return []
    states = _safe(state_set.get_states, []) or []
    return sorted(s.value_nick for s in states)


def _actions_of(obj: Atspi.Accessible) -> list[str]:
    """Action names exposed by an element.

    On GTK4 this is the most capable surface there is: `gnome-text-editor`
    publishes its whole command set here (`page.save`, `settings.show-line-numbers`)
    while its element tree is four nested empty panels. An inspection that
    returned only children would show nothing usable for that application.
    """
    if not _safe(lambda: obj.get_action_iface()):
        return []
    count = _safe(obj.get_n_actions, 0) or 0
    names = []
    for i in range(count):
        # `get_action_name` is deprecated in favour of `get_localized_name`,
        # but the localized form is what a user sees, not what an action is
        # called — invoking wants the stable name. Fall back only if it is gone.
        name = _safe(lambda idx=i: obj.get_action_name(idx), "") or _safe(
            lambda idx=i: obj.get_localized_name(idx), ""
        )
        if name:
            names.append(name)
    return names


def _bounds_of(obj: Atspi.Accessible) -> dict[str, int] | None:
    if not _safe(lambda: obj.get_component_iface()):
        return None
    extents = _safe(lambda: obj.get_extents(Atspi.CoordType.SCREEN))
    if extents is None:
        return None
    return {
        "x": extents.x,
        "y": extents.y,
        "width": extents.width,
        "height": extents.height,
    }


def _text_value(obj: Atspi.Accessible, role: str) -> str:
    """The element's editable/displayed text, where it has one.

    Bounded deliberately: a text editor's buffer can be megabytes, and the point
    of this project is that the model never receives a wall of content it did not
    ask for.
    """
    if role not in TEXT_VALUE_ROLES:
        return ""
    if not _safe(lambda: obj.get_text_iface()):
        return ""
    count = _safe(obj.get_character_count, 0) or 0
    if count <= 0:
        return ""
    return _safe(lambda: obj.get_text(0, min(count, MAX_VALUE_CHARS)), "") or ""


def _parent_digest(obj: Atspi.Accessible) -> str:
    """The parent's shallow digest.

    Deliberately *shallow* — the parent's own role, name and sibling index, not
    a recursive chain up to the root. Both the describe path and the staleness
    prober have to compute this identically or every reference would resolve as
    stale, and only the prober can afford one hop. One derivation, used by both.
    """
    parent = _safe(obj.get_parent)
    if parent is None:
        return ""
    return registry.Fingerprint(
        role=_safe(parent.get_role_name, "") or "",
        name=_safe(parent.get_name, "") or "",
        index=_safe(parent.get_index_in_parent, -1) or 0,
        parent="",
    ).digest()


def describe(obj: Atspi.Accessible, index: int, parent_digest: str) -> tuple:
    """One accessible, as (SemanticElement, Fingerprint, reference).

    Human-readable text is handed over raw and leaves through the egress policy
    inside `SemanticElement`, which is the property a later segment's redaction
    guarantee rests on.
    """
    obj_id = element_id(obj)
    _remember(obj, obj_id)
    role = _safe(obj.get_role_name, "") or ""
    states = _states_of(obj)
    element = model.SemanticElement(
        id=obj_id,
        backend=BACKEND_NAME,
        role=role,
        # Raw as read from the toolkit. `SemanticElement` applies the egress
        # policy in its constructor, so this text cannot reach a caller without
        # passing it — see `model.SemanticElement.__post_init__`.
        name=_safe(obj.get_name, "") or "",
        value=_text_value(obj, role),
        states=states,
        actions=_actions_of(obj),
        bounds=_bounds_of(obj),
        backend_reference=_reference(obj, obj_id),
    )
    # `parent_digest` from the walk is ignored in favour of asking the object
    # itself, so that a fingerprint taken during a walk and one taken later by
    # the prober are computed the same way. A fingerprint that depends on how it
    # was reached is not an identity.
    # The fingerprint uses the *emitted* name, not the raw one. If a policy
    # redacts a value, the fingerprint must be built from what the caller was
    # actually shown, or references would go stale the moment redaction is
    # switched on.
    fingerprint = registry.Fingerprint(
        role=role,
        name=element.name,
        index=_safe(obj.get_index_in_parent, index) if index is not None else index,
        parent=_parent_digest(obj),
    )
    return element, fingerprint, element.backend_reference


def children_of(obj: Atspi.Accessible) -> list[Atspi.Accessible]:
    count = _safe(obj.get_child_count, 0) or 0
    kids = []
    for i in range(count):
        child = _safe(lambda idx=i: obj.get_child_at_index(idx))
        if child is not None:
            kids.append(child)
    return kids


def find_window(win_id: str) -> Atspi.Accessible | None:
    """Locate a window by id, preferring the live object table.

    The table is checked first because a window that is still open is the common
    case and re-enumerating the whole desktop for it is wasteful. The scan is the
    fallback for a window first seen by another connection.
    """
    known = _objects.get(win_id)
    if known is not None and _safe(known.get_role_name) is not None:
        return known
    for app in _iter_desktop_apps():
        if (_safe(app.get_name, "") or "") in FRAME_PROVIDER_APPS:
            continue
        for window in _windows_of(app):
            if window_id(window) == win_id:
                _remember(window, win_id)
                return window
    return None


def fingerprint_of(reference: dict[str, Any]) -> registry.Fingerprint | None:
    """Current fingerprint of a previously described object, or None if it is gone.

    This is the registry's prober. A dead peer raises inside `gi`, which is
    precisely the signal that the reference is stale.
    """
    obj = _objects.get(reference.get("id", ""))
    if obj is None:
        return None
    role = _safe(obj.get_role_name)
    if role is None:
        return None
    index = _safe(obj.get_index_in_parent, -1)
    name = model.egress_value(
        _safe(obj.get_name, "") or "", field=model.NAME, role=role
    )
    return registry.Fingerprint(
        role=role,
        name=name,
        index=index if index is not None else -1,
        parent=_parent_digest(obj),
    )


#: How much of an application to search when re-finding a moved element. A stale
#: reference is an error path, not a browsing path: it is worth one bounded sweep
#: to hand the caller a usable id, and not worth walking a whole browser.
REDISCOVERY_MAX_NODES = 400


def rediscover(
    old: registry.Fingerprint, reference: dict[str, Any]
) -> tuple[str, dict[str, Any], registry.Fingerprint] | None:
    """Find an element that matches a fingerprint whose object no longer resolves.

    Searches the application the element came from, because that is where a
    widget that moved within its window still lives, and matches on role and
    name — deliberately not on position, since moving is exactly what happened.

    Returns None rather than guessing when the match is ambiguous: two identical
    buttons and no way to tell them apart is precisely the situation where
    handing back "one of them" would be worse than admitting the reference died.
    """
    bus = reference.get("busName", "")
    if not bus:
        return None

    candidates: list[tuple[Any, str, dict[str, Any], registry.Fingerprint]] = []
    searched = 0
    for app in _iter_desktop_apps():
        if _bus_name(app) != bus:
            continue
        frontier = list(_windows_of(app))
        while frontier and searched < REDISCOVERY_MAX_NODES:
            obj = frontier.pop(0)
            searched += 1
            role = _safe(obj.get_role_name)
            if role is None:
                continue
            name = model.egress_value(
                _safe(obj.get_name, "") or "", field=model.NAME, role=role
            )
            if role == old.role and name == old.name:
                new_id = element_id(obj)
                index = _safe(obj.get_index_in_parent, -1)
                candidates.append(
                    (
                        obj,
                        new_id,
                        _reference(obj, new_id),
                        registry.Fingerprint(
                            role=role,
                            name=name,
                            index=index if index is not None else -1,
                            parent=_parent_digest(obj),
                        ),
                    )
                )
                if len(candidates) > 1:
                    return None
            frontier.extend(children_of(obj))
    if len(candidates) != 1:
        return None
    obj, new_id, new_reference, fingerprint = candidates[0]
    # The caller is about to be handed this id; it has to resolve.
    _remember(obj, new_id)
    return new_id, new_reference, fingerprint
