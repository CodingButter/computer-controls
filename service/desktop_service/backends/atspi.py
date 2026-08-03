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
import logging
import time
from typing import Any, Callable, Sequence

import gi

gi.require_version("Atspi", "2.0")

from gi.repository import Atspi, Gio, GLib  # noqa: E402  (must follow require_version)

from .. import model, registry  # noqa: E402
from . import x11  # noqa: E402

log = logging.getLogger(__name__)

BACKEND_NAME = "atspi"

# How long to wait for the session bus to say whether an accessibility bus exists.
# Short on purpose: this runs before anything else can, and a machine that cannot
# answer in three seconds is a machine we are going to report as unavailable.
BUS_PROBE_TIMEOUT_MS = 3000

# How long a "no bus" answer stands before it is asked again. A desktop that
# starts after this service did is a normal thing to happen and should not need a
# restart to be noticed; a bus-less machine should not pay a D-Bus round trip per
# call to be told the same thing.
BUS_RETRY_SECONDS = 5.0

#: The remembered answer. `None` means nobody has asked yet.
_bus_ok: bool | None = None
_bus_reason: str | None = None
_bus_asked_at: float = 0.0


def forget_bus_answer() -> None:
    """Drop the cached reachability answer. For tests, and for a deliberate recheck."""
    global _bus_ok, _bus_reason, _bus_asked_at
    _bus_ok, _bus_reason, _bus_asked_at = None, None, 0.0

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

# How far up an ancestor chain to look for the window an element sits in. Bounded
# because a broken toolkit can hand back a parent chain that never terminates, and an
# unbounded walk there hangs the loop thread every other call answers on.
MAX_ANCESTOR_WALK = 32

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


def bus_reachable() -> tuple[bool, str | None]:
    """Ask the session bus whether an accessibility bus exists, without touching Atspi.

    This has to exist because of how `Atspi` fails. When there is no accessibility
    bus to connect to, `Atspi.get_desktop(0)` does not raise — it emits a
    `dbind-ERROR` through `g_error`, and `g_error` calls `abort()`. There is no
    Python exception to catch: the whole process dies with a core dump, taking
    every other client of a shared daemon with it. An `except Exception` around
    that call is decorative, and we shipped one for months.

    The same question asked over plain D-Bus fails politely: `Gio` raises
    `GLib.Error` and the process survives. So the rule is that nothing calls into
    `Atspi` until this has answered yes.

    A yes is remembered for the life of the process. The abort happens when the
    bridge first *connects*; once it has, a bus that later goes away surfaces as
    ordinary D-Bus errors that `_safe` already absorbs. Re-asking would put a
    blocking round trip on the one thread every client's calls are marshalled
    onto — a third of a millisecond each, on tree walks that make thousands.
    A no is remembered only briefly, because a desktop that comes up after the
    service did should be picked up without a restart.
    """
    global _bus_ok, _bus_reason, _bus_asked_at
    now = time.monotonic()
    if _bus_ok is True:
        return True, None
    if _bus_ok is False and (now - _bus_asked_at) < BUS_RETRY_SECONDS:
        return False, _bus_reason
    ok, reason = _ask_the_bus()
    _bus_ok, _bus_reason, _bus_asked_at = ok, reason, now
    return ok, reason


def _ask_the_bus() -> tuple[bool, str | None]:
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        reply = bus.call_sync(
            "org.a11y.Bus",
            "/org/a11y/bus",
            "org.a11y.Bus",
            "GetAddress",
            None,
            GLib.VariantType("(s)"),
            Gio.DBusCallFlags.NONE,
            BUS_PROBE_TIMEOUT_MS,
            None,
        )
    except GLib.Error as exc:
        return False, f"no accessibility bus: {exc.message}"
    except Exception as exc:  # noqa: BLE001 - a broken session bus is not our bug
        return False, f"no accessibility bus: {type(exc).__name__}: {exc}"
    address = reply.unpack()[0]
    if not address:
        return False, "the session bus answered with an empty accessibility bus address"
    return True, None


def _desktop() -> Atspi.Accessible | None:
    """The one door to the toolkit's root, and the only place that opens it.

    Every route into AT-SPI starts by asking for the desktop, so guarding the
    question here guards all of them at once. The first version of this guard
    was put on `probe_desktop` alone, which read as sufficient and was not: the
    window lookup underneath `typeText` reaches the root by another path, and a
    bus-less machine still died — several layers below anything that looked like
    a probe. One door, checked once, is the only shape that stays true when
    somebody adds a fourth caller.
    """
    reachable, _ = bus_reachable()
    if not reachable:
        return None
    return Atspi.get_desktop(0)


def probe_desktop() -> dict[str, Any]:
    """Decide whether the accessibility bridge actually works by using it.

    The `toolkit-accessibility` gsetting reads `false` on this machine while the
    bridge is fully functional, so it is not consulted anywhere.
    """
    reachable, reason = bus_reachable()
    if not reachable:
        return {"available": False, "reason": reason}
    try:
        desktop = _desktop()
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
    desktop = _desktop()
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


def xid_for(pid: int, raw_title: str) -> int | None:
    """The display server's id for the window the accessibility layer is describing.

    The two layers share no identifier, so the match is made on the two facts both of
    them report: the process and the title. An exact match on both is preferred. When
    the titles disagree — Chrome, for one, tells the accessibility layer a longer title
    than it tells the window manager — a process that owns exactly one window is still
    an unambiguous answer. A process with several windows and no title match is not, and
    gets None rather than a guess.

    The title used here is the raw one, deliberately taken before the value-egress point:
    a redaction policy that rewrites titles must not quietly break window matching.
    """
    candidates = [w for w in x11.toplevels() if w.pid == pid]
    for window in candidates:
        if window.title == raw_title:
            return window.xid
    if len(candidates) == 1:
        return candidates[0].xid
    return None


def xid_of(window: Atspi.Accessible) -> int | None:
    """The display server's id for a window object the caller already holds.

    The raw title is read here rather than the emitted one, for the reason `xid_for`
    gives: matching the two layers must not depend on what a redaction policy allows out.
    """
    app = _safe(window.get_application)
    pid = _safe(lambda: app.get_process_id(), 0) if app is not None else 0
    raw_title = _safe(window.get_name, "") or ""
    return xid_for(pid or 0, raw_title)


def application_name_of(window: Atspi.Accessible) -> str:
    """The raw name of the application owning a window.

    Raw for the same reason `xid_of` reads the raw title: this name is matched against
    a capture blocklist, and a policy decision that depended on what redaction let out
    would fail open exactly where it matters most.
    """
    app = _safe(window.get_application)
    if app is None:
        return ""
    return _safe(app.get_name, "") or ""


def list_windows(application_id_filter: str | None = None) -> list[dict[str, Any]]:
    windows: list[dict[str, Any]] = []
    active_xid = x11.active_xid()
    for app in _iter_desktop_apps():
        app_name = _safe(app.get_name, "") or ""
        if app_name in FRAME_PROVIDER_APPS:
            continue
        app_id = application_id(app)
        if application_id_filter and app_id != application_id_filter:
            continue
        app_pid = _safe(app.get_process_id, 0) or 0
        for window in _windows_of(app):
            states = _window_states(window)
            raw_title = _safe(window.get_name, "") or ""
            # Not a single window in this session reports the accessibility layer's
            # `active` state, so believing it would mean reporting that nothing is ever
            # focused. The display server is asked instead, and says so honestly.
            xid = xid_for(app_pid, raw_title) if active_xid else None
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
                    "active": ("active" in states) or (xid is not None and xid == active_xid),
                    "states": states,
                    "backend": BACKEND_NAME,
                }
            )
    return windows


def application_pids() -> dict[str, int]:
    """Which process each application on this desktop is.

    Applications, not windows: the walk stops one level up from `list_windows`, so asking
    who owns a window costs an application enumeration rather than a full window walk.
    """
    return {
        application_id(app): _safe(app.get_process_id, 0) or 0 for app in _iter_desktop_apps()
    }


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
    # Read through the Text interface explicitly. Atspi.Accessible.get_text is a
    # different function that takes no range and returns the interface itself —
    # calling it with a range raises TypeError, which _safe would swallow into an
    # empty string. Every text value in this backend was empty for that reason.
    return (
        _safe(lambda: Atspi.Text.get_text(obj, 0, min(count, MAX_VALUE_CHARS)), "")
        or ""
    )


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


def parent_of(obj: Atspi.Accessible) -> Atspi.Accessible | None:
    """The parent accessible, or None at the root.

    Callers that walk upward cap the chain themselves — see
    ``MAX_ANCESTOR_WALK`` for the broken-toolkit hazard that makes that cap
    non-negotiable.
    """
    return _safe(obj.get_parent)


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


def scope_of(obj: Atspi.Accessible) -> tuple[str, str]:
    """The window and application an object belongs to, as ids.

    Recorded when an action is dispatched, while the object is still resolvable, because
    this is what separates an effect from a coincidence later: a change inside an action's
    revision range but in some other application was not caused by that action, and the
    only way to know that is to have written down where the action could reach.

    An object whose window has already gone answers with what it can. A partial scope
    narrows attribution rather than breaking it.
    """
    window_ref = ""
    node = obj
    for _ in range(MAX_ANCESTOR_WALK):
        if node is None:
            break
        role = _safe(node.get_role_name, "") or ""
        if role in WINDOW_ROLES:
            window_ref = window_id(node)
            break
        node = _safe(node.get_parent)

    app = _safe(obj.get_application)
    app_ref = application_id(app) if app is not None else ""
    return window_ref, app_ref


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


# --- Acting -------------------------------------------------------------------
#
# Three primitives, and nothing else. Every action the protocol offers is one of
# these or a batch of them. Notably absent: anything that synthesizes a keystroke or
# moves a pointer. Setting a text field means handing the text to the toolkit, not
# typing it at the window and hoping focus was where we thought it was.


def grab_focus(obj: Atspi.Accessible) -> bool:
    """Ask the toolkit to focus an element. False if it cannot or will not."""
    if not _safe(lambda: obj.get_component_iface()):
        return False
    return bool(_safe(obj.grab_focus, False))


def actions_of(obj: Atspi.Accessible) -> list[str]:
    """Public read of the exposed action names, for error messages that help."""
    return _actions_of(obj)


def action_count_of(obj: Atspi.Accessible) -> int:
    """How many actions an element exposes, without asking for their names.

    Separate from `actions_of` because the probe asks this of every node it
    walks: naming an action costs a round trip each, and a six-hundred-node walk
    that wanted only the count would pay for hundreds of strings it discards.
    """
    if not _safe(lambda: obj.get_action_iface()):
        return 0
    return _safe(obj.get_n_actions, 0) or 0


def interfaces_of(obj: Atspi.Accessible) -> list[str]:
    """Which AT-SPI interfaces this object advertises.

    A claim, not a guarantee — `collection_answers` is the test of it.
    """
    return _safe(obj.get_interfaces, []) or []


def role_of(obj: Atspi.Accessible) -> str:
    return _safe(obj.get_role_name, "") or ""


def toolkit_of(app: Atspi.Accessible) -> tuple[str, str]:
    """The toolkit name and version an application reports for itself."""
    return (
        _safe(app.get_toolkit_name, "") or "",
        _safe(app.get_toolkit_version, "") or "",
    )


def collection_answers(app: Atspi.Accessible) -> bool:
    """Whether a `Collection` query returns, rather than whether one is offered.

    Applications advertise this interface and then decline to serve it. The
    interface list is a claim; this is the test, and the gap between the two is
    the entire reason the manual walk exists.
    """

    def query() -> bool:
        rule = Atspi.MatchRule.new(
            Atspi.StateSet.new([]),
            Atspi.CollectionMatchType.ANY,
            {},
            Atspi.CollectionMatchType.ANY,
            [],
            Atspi.CollectionMatchType.ANY,
            [],
            Atspi.CollectionMatchType.ANY,
            False,
        )
        return app.get_matches(rule, Atspi.CollectionSortOrder.CANONICAL, 1, False) is not None

    return bool(_safe(query, False))


def windows_of_application(app_id: str) -> list[Atspi.Accessible]:
    """The window objects of one application, or an empty list if it is gone."""
    app = find_application(app_id)
    return _windows_of(app) if app is not None else []


def do_action(obj: Atspi.Accessible, action_name: str) -> bool:
    """Invoke a named action. Returns False when the toolkit declines it.

    Actions are addressed by NAME, never by the index AT-SPI actually wants. An index
    is only meaningful relative to a list that the application is free to reorder
    between one call and the next; a name that has moved is a name that no longer
    matches, which is a clean failure instead of a wrong button.
    """
    names = _actions_of(obj)
    if action_name not in names:
        return False
    index = names.index(action_name)
    return bool(_safe(lambda: obj.do_action(index), False))


def set_text_value(obj: Atspi.Accessible, text: str) -> bool:
    """Replace an element's text through the EditableText interface."""
    if not _safe(lambda: obj.get_editable_text_iface()):
        return False
    return bool(_safe(lambda: obj.set_text_contents(text), False))


def insert_text(obj: Atspi.Accessible, text: str, offset: int = -1) -> bool:
    """Insert at a caret position without disturbing what is already there.

    The interface an application receives dictated speech through, used here for
    the same reason: an application that listens for edits hears these, where it
    hears nothing at all when a field's whole contents are swapped underneath it.

    An offset of -1 means the end, which is where a person typing would be.
    """
    if not _safe(lambda: obj.get_editable_text_iface()):
        return False
    at = offset
    if at < 0:
        at = len(_safe(lambda: Atspi.Text.get_text(obj, 0, -1), "") or "")
    return bool(_safe(lambda: obj.insert_text(at, text, len(text)), False))


def delete_text(obj: Atspi.Accessible, start: int, end: int) -> bool:
    """Remove a range of characters by offset.

    This is what editing is at this layer. There is no backspace to press and no
    selection to make first: a range is spliced out in one call, atomically,
    which is both simpler than imitating a person and more truthful — an
    application sees one edit rather than forty deletions it has to coalesce.

    A selection can be set beforehand if a human should watch the text highlight
    before it goes, but that is presentation. The removal does not need it.
    """
    if not _safe(lambda: obj.get_editable_text_iface()):
        return False
    length = len(_safe(lambda: Atspi.Text.get_text(obj, 0, -1), "") or "")
    if start < 0 or end > length or start >= end:
        # Out-of-range offsets are the caller holding a stale idea of the field,
        # which is worth an honest refusal rather than a clamp that deletes
        # something adjacent to what was meant.
        return False
    return bool(_safe(lambda: obj.delete_text(start, end), False))


def select_text(obj: Atspi.Accessible, start: int, end: int) -> bool:
    """Highlight a range, so a person can see what is about to change."""
    if not _safe(lambda: obj.get_text_iface()):
        return False
    if _safe(lambda: Atspi.Text.get_n_selections(obj), 0):
        _safe(lambda: Atspi.Text.remove_selection(obj, 0), False)
    return bool(_safe(lambda: Atspi.Text.add_selection(obj, start, end), False))


def find_range(obj: Atspi.Accessible, needle: str) -> tuple[int, int] | None:
    """Where a piece of text sits in a field, as offsets, or nothing if absent.

    Addressing an edit by the text being replaced rather than by raw offsets is
    the same discipline as naming an action instead of indexing it: an offset
    computed from a field somebody has since typed into points at the wrong
    characters, while text that has moved simply is not found.
    """
    if not needle:
        return None
    body = _safe(lambda: Atspi.Text.get_text(obj, 0, -1), "") or ""
    at = body.find(needle)
    if at < 0 or body.find(needle, at + 1) >= 0:
        # Ambiguity is refused: two matches mean the caller does not know which
        # one it meant, and guessing edits the wrong sentence.
        return None
    return at, at + len(needle)


def text_contains(obj: Atspi.Accessible, needle: str) -> str:
    """Whether a field holds this text anywhere in it — the verdict, not the text.

    An edit lands in the middle of a field, so confirming one is a containment
    question rather than an equality question. Same discipline as `text_matches`,
    including its third answer: a field that masks its own contents cannot
    confirm or deny, and saying so is more use than a confident no.
    """
    role = _safe(obj.get_role_name, "") or ""
    return verdict_for(_text_value(obj, role), needle, contains=True)


def is_editable(obj: Atspi.Accessible) -> bool:
    """Whether this element accepts text at all, asked before any is sent."""
    return bool(_safe(lambda: obj.get_editable_text_iface()))


def read_for_attest(obj: Atspi.Accessible) -> str | None:
    """The field's raw text for attestation, or None when the field is masked.

    Attestation stores what the service can see right now, so a later commit
    can prove it has not changed. A field whose contents even this service
    cannot read — a password entry handing the accessibility layer bullets —
    has nothing to attest against, so None means the caller should refuse rather
    than store a mask that no honest comparison could match.
    """
    role = _safe(obj.get_role_name, "") or ""
    text = _text_value(obj, role)
    if text and set(text) <= _MASK_CHARACTERS:
        return None
    return text


def text_matches(obj: Atspi.Accessible, expected: str, exact: bool) -> str:
    """Does the field now say what it was supposed to say?

    Three answers, not two. The comparison happens here, against the raw text,
    and only the verdict leaves: asking the caller to compare would mean handing
    it the field's contents to compare against, and a field redacted on the way
    out could never be verified at all.

    The third answer exists because a password entry does not hand its contents
    even to us. GTK returns a row of bullets to the accessibility layer itself,
    so the text we would compare against is the mask. Reporting that as a
    mismatch would be a lie in the most alarming direction — telling a caller
    its password did not go in when it did, and inviting it to type the thing
    again. `unverifiable` says what is actually true: the words were delivered
    and nothing on this desktop can confirm the result.
    """
    role = _safe(obj.get_role_name, "") or ""
    return verdict_for(_text_value(obj, role), expected, exact=exact)


#: Characters toolkits substitute for a password's real contents. A field made
#: entirely of one of these, where we asked for something else, is masked rather
#: than wrong.
_MASK_CHARACTERS = frozenset("•*●·⬤∙")


def _is_masked(actual: str, expected: str) -> bool:
    if not actual or actual == expected:
        return False
    return set(actual) <= _MASK_CHARACTERS


def verdict_for(actual: str, expected: str, *, exact: bool = True, contains: bool = False) -> str:
    """The three-way answer, decided in one place.

    Split out from the two functions above so that the rule lives once. The
    version of this that mattered was written twice — once here and once in a
    test's stub — and the copy in the stub kept saying `True` for a masked
    field long after this one had learned better.
    """
    if _is_masked(actual, expected):
        return "unverifiable"
    if contains:
        matched = expected in actual
    else:
        matched = actual == expected if exact else actual.endswith(expected)
    return "verified" if matched else "mismatch"


def set_numeric_value(obj: Atspi.Accessible, amount: float) -> bool:
    """Set a slider or spinner through the Value interface, refusing out-of-range.

    The toolkit would clamp silently. A caller who asked for 200 on a scale that stops
    at 100 has a wrong belief about the world, and returning success would preserve it.
    """
    if not _safe(lambda: obj.get_value_iface()):
        return False
    minimum = _safe(obj.get_minimum_value)
    maximum = _safe(obj.get_maximum_value)
    if minimum is not None and amount < minimum:
        return False
    if maximum is not None and amount > maximum:
        return False
    return bool(_safe(lambda: obj.set_current_value(amount), False))


def sample_values(element_ids: Sequence[str]) -> dict[str, str]:
    """Current values for elements a caller already holds, skipping the unreachable.

    Only elements someone has been shown are sampled. Reading every text field of
    every window on every observation would cost more than everything it measured,
    and nobody is holding a reference to most of them anyway.

    An element that has gone is simply absent from the result rather than an error:
    disappearance is the registry's subject and staleness its vocabulary, and a
    value sample that raised would take the whole observation down with it.
    """
    sampled: dict[str, str] = {}
    for element_id in element_ids:
        obj = _objects.get(element_id)
        if obj is None:
            continue
        role = _safe(obj.get_role_name, "") or ""
        if role not in TEXT_VALUE_ROLES:
            continue
        sampled[element_id] = read_back(obj, element_id)
    return sampled


def owners_of(element_ids: Sequence[str]) -> dict[str, tuple[str, str]]:
    """Which application each held element belongs to, as (id, name).

    A value change is the one change the diff engine can see without ever having
    looked at a window, and until now it said so anonymously. That was fine while
    the only reader was a client watching the whole desktop; it is wrong for one
    watching a single application, which would either be told about typing
    somewhere it is not looking or — if the filter guessed — never told at all.

    Asked alongside the sample rather than derived from it: the answer comes from
    the live object, and the live object is only reliably there while the element
    is still reachable.
    """
    owners: dict[str, tuple[str, str]] = {}
    for element_id in element_ids:
        obj = _objects.get(element_id)
        if obj is None:
            continue
        app = _safe(obj.get_application)
        if app is None:
            continue
        owners[element_id] = (
            application_id(app),
            model.egress_value(
                _safe(app.get_name, "") or "",
                field=model.APPLICATION_NAME,
                role="application",
            ),
        )
    return owners


def read_back(obj: Atspi.Accessible, element_id: str = "") -> str:
    """Whatever the element now says its value is, through the egress point.

    A set-value result quotes the field back so the caller can see what actually landed
    — and a password field's contents are exactly as sensitive on the way out of a write
    as on the way out of a read. Same door.
    """
    role = _safe(obj.get_role_name, "") or ""
    return model.egress_value(
        _text_value(obj, role),
        field=model.VALUE,
        role=role,
        states=tuple(_states_of(obj)),
        element_id=element_id,
    )


# The events worth waking up for. Not an exhaustive list of what AT-SPI broadcasts —
# deliberately. Every registered event costs a D-Bus round trip per occurrence, and the
# ones omitted here (caret movement, every keystroke's text insertion) fire continuously
# while a human types without ever meaning "the desktop is now different".
WATCHED_EVENTS = (
    "window:create",
    "window:destroy",
    "window:activate",
    "window:deactivate",
    "object:state-changed:focused",
    "object:state-changed:showing",
    "object:children-changed",
    "object:property-change:accessible-value",
)

#: Registered listeners, each paired with the event name it was registered for. The pair
#: is the point: a listener must be deregistered with the same name it registered with,
#: and deregistering with anything else tears down the underlying match without unhooking
#: this listener — after which the process receives no desktop events at all and every
#: later subscription registers successfully into silence.
_listeners: list[tuple[Atspi.EventListener, str]] = []


def watch_events(on_hint: Callable[[], None]) -> Callable[[], None]:
    """Subscribe to the events that mean 'look again'. Returns an unsubscribe.

    The payload is deliberately dropped. An event carries a reference to the object that
    changed, and building the delta out of that reference would make the event stream a
    second source of truth about the desktop — one that is authoritative for whatever it
    happened to mention and blind to everything it did not. The re-read stays the only
    account of what is true; the event only decides when to take it.

    Must be called on the loop thread: AT-SPI delivers events on the thread whose main
    context it was initialised with.
    """

    def deliver(_event: object) -> None:
        try:
            on_hint()
        except Exception:
            # An event listener that raises inside GLib takes out the loop every other
            # call in this process depends on.
            log.exception("desktop event hint failed")

    mine: list[tuple[Atspi.EventListener, str]] = []
    # Registering a listener connects to the bridge, and connecting to a bridge
    # that is not there aborts the process — the same way a desktop lookup does,
    # by a route that never asks for the desktop. Watching nothing is the honest
    # answer on a machine with no bus: the reconciliation sweep still runs, and
    # `getDeltaSince` still reports whatever a re-read finds.
    reachable, reason = bus_reachable()
    if not reachable:
        log.warning("not watching desktop events: %s", reason)
        return lambda: None
    for name in WATCHED_EVENTS:
        listener = Atspi.EventListener.new(deliver)
        if listener.register(name):
            mine.append((listener, name))
    _listeners.extend(mine)

    def unsubscribe() -> None:
        for listener, name in mine:
            _safe(lambda l=listener, n=name: l.deregister(n))
            if (listener, name) in _listeners:
                _listeners.remove((listener, name))

    return unsubscribe
