"""Method registry and process entry point.

This module is the seam between the protocol and the desktop: it owns the method
table, and every handler that needs the desktop goes through `call_on_loop`. It
imports no toolkit binding of its own.
"""

from __future__ import annotations

import argparse
import ctypes
import logging
import os
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any

from . import (
    actions,
    attention,
    audit,
    cadence,
    capabilities,
    config,
    deltas,
    holds,
    identity,
    inspect as inspection,
    model,
    policy,
    presence,
    protocol_generated,
    redaction,
    security,
    state,
    subscriptions,
    waitfor,
    watch,
)
from .backends import atspi, capture, launcher, loop, session_env, x11
from .errors import DesktopError, ErrorCode, InvalidParams
from .registry import ElementRegistry, ElementReferenceStale
from .session import Session
from . import transport
from .transport import JsonRpcServer, default_socket_path
from .validate import validate_params, validate_result

log = logging.getLogger(__name__)

# One registry per service process: element ids and the revision counter are
# session-scoped, and the session is the process.
_registry = ElementRegistry(prober=atspi.fingerprint_of, rediscoverer=atspi.rediscover)

# Likewise one session: several clients share this service instance, so they
# share its element namespace, its revision counter and its observation mode.
_session = Session()

#: The service must always give up before its callers do, or a slow-but-working
#: sweep surfaces to the model as a transport failure with nothing to act on.
#: The client's request timeout is 20s; every backend budget here stays under it
#: so the caller receives a structured TIMEOUT naming what timed out.
WALK_TIMEOUT_SECONDS = 15.0
SINGLE_ELEMENT_TIMEOUT_SECONDS = 10.0

#: Expansion runs inside ``query()`` under this soft deadline, which is checked
#: between describe calls rather than by the loop timeout: ``call_on_loop``
#: destroys the source on expiry (loop.py:188-191), which would lose the partial
#: answer. Twelve seconds leaves three seconds of margin under the 15s hard
#: backstop and eight under the client's 20s request timeout.
EXPANSION_BUDGET_SECONDS = 12.0
MAX_SIBLINGS_PER_HIT = 10
MAX_EXPAND_NODES = 2000


def _require_window(window_id: str):
    window = atspi.find_window(window_id)
    if window is None:
        raise DesktopError(
            ErrorCode.WINDOW_NOT_FOUND,
            f"No window with id {window_id!r} is open",
            {"windowId": window_id},
        )
    return window


def _str_param(params: dict[str, Any], key: str, required: bool = False) -> str | None:
    value = params.get(key)
    if value is None:
        if required:
            raise InvalidParams(f"{key!r} is required", {"parameter": key})
        return None
    if not isinstance(value, str):
        raise InvalidParams(
            f"{key!r} must be a string", {"parameter": key, "received": type(value).__name__}
        )
    return value


def _int_param(params: dict[str, Any], key: str, default: int, maximum: int) -> int:
    value = params.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool):
        raise InvalidParams(
            f"{key!r} must be an integer", {"parameter": key, "received": type(value).__name__}
        )
    if value < 1:
        raise InvalidParams(f"{key!r} must be at least 1", {"parameter": key, "received": value})
    # Clamped rather than rejected: a caller asking for too much gets a bounded
    # answer plus the truncation marker, which is more useful than an error.
    return min(value, maximum)


def _bool_param(params: dict[str, Any], key: str, default: bool = False) -> bool:
    value = params.get(key, default)
    if not isinstance(value, bool):
        raise InvalidParams(
            f"{key!r} must be a boolean", {"parameter": key, "received": type(value).__name__}
        )
    return value


def _optional_int_param(
    params: dict[str, Any], key: str, maximum: int
) -> int:
    """An integer that defaults to 0 (off) and rejects out-of-range values."""
    value = params.get(key, 0)
    if not isinstance(value, int) or isinstance(value, bool):
        raise InvalidParams(
            f"{key!r} must be an integer", {"parameter": key, "received": type(value).__name__}
        )
    if value < 0:
        raise InvalidParams(
            f"{key!r} must be at least 0", {"parameter": key, "received": value}
        )
    return min(value, maximum)


def _method_capabilities(_params: dict[str, Any]) -> dict[str, Any]:
    return capabilities.build_report(
        lambda: loop.call_on_loop(atspi.probe_desktop, timeout=10.0),
        capture.unavailable_reason,
        session_token=_session.token,
        observation_mode=_session.mode,
        discover_session=session_env.discover,
    )


def _withheld(rows: list[dict[str, Any]], *keys: str) -> list[dict[str, Any]]:
    """Drop the rows belonging to an application the user walled off.

    A blocked application is absent rather than present-and-refused. The
    difference matters: a refusal confirms the application is running, and its
    window title — which is a document name, a contact's name, the subject of a
    message — is exactly the kind of thing somebody blocks an application to
    keep out of a transcript. Filtering here rather than deeper down keeps the
    delta engine's own picture of the desktop complete, so a window that
    reappears from behind the wall is still noticed as having moved.
    """
    ceiling = _consent.ceiling
    if not ceiling.blocked_applications and not ceiling.applications:
        return rows

    def identity(row: dict[str, Any]) -> str:
        # One identity per row, in the caller's order of preference — the same
        # name the guard resolves for a targeted call, so a row that is listed
        # is a row that can then be acted on. Checking every field instead
        # would break an allowlist: an entry naming an application by name
        # would fail against the same row's opaque id and hide what the user
        # asked to allow.
        for key in keys:
            value = row.get(key)
            if isinstance(value, str) and value:
                return value
        return ""

    return [row for row in rows if ceiling.permits_application(identity(row))]


def _attended(
    rows: list[dict[str, Any]], want: attention.Attention, *keys: str
) -> list[dict[str, Any]]:
    """Drop the rows this connection said it was not looking at.

    Unlike the ceiling above, every way a row names its application counts here:
    a client narrowing its own view is not drawing a security boundary, so being
    forgiving about whether it said the id or the name costs nothing. It matches
    on the same set of keys either way, which is what makes the two filters
    composable rather than merely adjacent.
    """
    if not want.scoped:
        return rows
    return [row for row in rows if want.covers(*(row.get(key) or "" for key in keys))]


def _visible(params: dict[str, Any], rows: list[dict[str, Any]], *keys: str) -> list[dict[str, Any]]:
    """Rows this caller may see, then rows this caller asked to see.

    The order is the whole argument. The ceiling runs first and produces a set
    attention can only shrink, so there is no declaration — including one naming
    a blocked application outright — that puts a withheld row back. Attention
    narrows a view; it cannot widen one.
    """
    return _attended(_withheld(rows, *keys), attention.of(_client_id(params)), *keys)


def _method_list_applications(params: dict[str, Any]) -> dict[str, Any]:
    applications = loop.call_on_loop(atspi.list_applications)
    return {
        "applications": _visible(params, applications, "name", "id"),
        "backend": atspi.BACKEND_NAME,
    }


def _method_list_windows(params: dict[str, Any]) -> dict[str, Any]:
    application_id = params.get("applicationId")
    if application_id is not None and not isinstance(application_id, str):
        raise InvalidParams(
            "'applicationId' must be a string when provided",
            {"received": type(application_id).__name__},
        )
    windows = loop.call_on_loop(atspi.list_windows, application_id)
    return {
        "windows": _visible(params, windows, "applicationName", "applicationId"),
        "backend": atspi.BACKEND_NAME,
    }


MAX_DEPTH = 12

#: What the cap becomes once a connection has said which applications it is
#: watching, **and the walk starts inside one of them**. The shallow number was
#: never a statement about twelve being the interesting depth — it was the only
#: defence against a walk that starts at the desktop and does not know where it
#: is going. A scoped walk starts inside one application, and the node budget
#: below is unchanged, so the real cost bound still holds while the arbitrary
#: one gets out of the way. This is what makes a text editor's document buffer —
#: which sits below twelve levels of scaffolding when counted from the frame —
#: reachable without drilling. A scoped connection inspecting something it did
#: not name is outside that argument and gets the flat cap.
SCOPED_MAX_DEPTH = 64
MAX_NODES = 1000
MAX_QUERY_LIMIT = 200


def _depth_ceiling(params: dict[str, Any]) -> int:
    """How deep this particular walk may go.

    The lift is earned by where the walk starts, not by what the connection
    said it was interested in. Those are the same thing exactly when the target
    is one of the declared applications, and a connection that declares an
    editor and then walks a browser is the case that made them different.

    Attention can only ever subtract — that is the whole distinction between it
    and the consent ceiling — so a lift granted on the strength of a
    declaration alone would be attention adding capability, which is the one
    thing this module says it never does. Checking the target keeps the
    relaxation and the sentence justifying it as the same fact.

    The target is resolved only for a connection that is scoped and asking for
    the deep budget. An undeclared connection is capped at the shallow ceiling
    whatever it names, so the lookup would be a per-call tax on a question
    already answered.

    On a desktop whose consent ceiling names applications, `_guarded` has
    already resolved the same target for the permission check, so this is a
    second identical lookup on that one path. Measured at 1.3ms median against
    a deep walk that costs upwards of 400ms, which is not worth threading a
    resolved name through the guard seam to avoid — but it is a round trip on
    the single thread every client shares, so it is worth knowing it is here
    before adding a third.
    """
    focus = attention.of(_client_id(params))
    ceiling = focus.depth_ceiling(MAX_DEPTH, SCOPED_MAX_DEPTH)
    if ceiling == MAX_DEPTH:
        return ceiling
    if not focus.covers(_application_of(params)):
        return MAX_DEPTH
    return ceiling


def _method_inspect_window(params: dict[str, Any]) -> dict[str, Any]:
    window_id = _str_param(params, "windowId", required=True)
    include = params.get("includeRoles")
    exclude = params.get("excludeRoles") or []
    bounds = inspection.Bounds(
        depth=_int_param(params, "depth", inspection.DEFAULT_DEPTH, _depth_ceiling(params)),
        max_nodes=_int_param(params, "maxNodes", inspection.DEFAULT_MAX_NODES, MAX_NODES),
        include_roles=frozenset(include) if include else None,
        exclude_roles=frozenset(exclude),
    )

    def work():
        window = _require_window(window_id)
        return inspection.inspect_tree(
            window, describe=atspi.describe, children=atspi.children_of, bounds=bounds
        )

    result = loop.call_on_loop(work, timeout=WALK_TIMEOUT_SECONDS)
    revision = _registry.record(result.observations)
    return {
        "window": result.root.to_json(),
        "nodeCount": result.node_count,
        "truncated": result.truncated,
        "revision": revision,
        "backend": atspi.BACKEND_NAME,
    }


def _method_query_elements(params: dict[str, Any]) -> dict[str, Any]:
    window_id = _str_param(params, "windowId", required=True)
    role = _str_param(params, "role")
    name = _str_param(params, "name")
    states = frozenset(params.get("states") or [])
    if role is None and name is None and not states:
        raise InvalidParams(
            "a query needs at least one of 'role', 'name' or 'states' — an "
            "unfiltered query is a whole-tree dump by another name",
            {"parameters": ["role", "name", "states"]},
        )
    limit = _int_param(params, "limit", 50, MAX_QUERY_LIMIT)
    ancestors = _optional_int_param(params, "ancestors", inspection.MAX_ANCESTORS)
    descendants = _optional_int_param(params, "descendants", inspection.MAX_DESCENDANTS)
    siblings = _bool_param(params, "siblings", False)
    wants_expansion = ancestors > 0 or descendants > 0 or siblings

    def work():
        window = _require_window(window_id)
        return inspection.query(
            window,
            describe=atspi.describe,
            children=atspi.children_of,
            parent_of=atspi.parent_of if wants_expansion else None,
            role=role,
            name=name,
            states=states,
            limit=limit,
            ancestors=ancestors,
            descendants=descendants,
            siblings=siblings,
            max_expand_nodes=MAX_EXPAND_NODES,
            max_siblings_per_hit=MAX_SIBLINGS_PER_HIT,
            deadline=time.monotonic() + EXPANSION_BUDGET_SECONDS
            if wants_expansion
            else None,
        )

    found = loop.call_on_loop(work, timeout=WALK_TIMEOUT_SECONDS)
    revision = _registry.record(found.observations)
    return {
        "elements": [m.to_json() for m in found.matches],
        "matchCount": len(found.matches),
        "searchTruncated": found.truncated,
        "moreResults": found.more,
        "neighbourhoodTruncated": found.neighbourhood_truncated,
        "revision": revision,
        "backend": atspi.BACKEND_NAME,
    }


def _method_get_element(params: dict[str, Any]) -> dict[str, Any]:
    element_id = _str_param(params, "elementId", required=True)

    def work():
        entry = _registry.resolve(element_id)
        obj = atspi.lookup(element_id)
        if obj is None:
            raise DesktopError(
                ErrorCode.ELEMENT_NOT_FOUND,
                f"Element {element_id!r} is no longer reachable",
                {"elementId": element_id},
            )
        element, _fp, _ref = atspi.describe(obj, entry.fingerprint.index, "")
        return element

    element = loop.call_on_loop(work, timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS)
    return {
        "element": element.to_json(),
        "revision": _registry.revision,
        "backend": atspi.BACKEND_NAME,
    }


def _method_inspect_element(params: dict[str, Any]) -> dict[str, Any]:
    """Walk from an element the caller already holds, budget measured from there.

    Window inspection spends its depth on the path down from the frame, and on real
    applications that path is mostly scaffolding: `gnome-text-editor`'s document buffer
    sits below the shallow maximum depth, so an unscoped window inspection cannot reach it.
    Raising that cap for everyone would make every inspection more expensive to fix a
    problem about where the walk starts — which is why the cap moves only for a connection
    that has said which applications it is watching, and drilling stays available to one
    that has not.

    The anchor is resolved through the registry first, so drilling from a reference whose
    element has been rebuilt raises `ELEMENT_REFERENCE_STALE` — with re-resolution — in
    exactly the way every other method does, instead of quietly walking a neighbour that
    happens to look similar.
    """
    element_id = _str_param(params, "elementId", required=True)
    include = params.get("includeRoles")
    exclude = params.get("excludeRoles") or []
    bounds = inspection.Bounds(
        depth=_int_param(params, "depth", inspection.DEFAULT_DEPTH, _depth_ceiling(params)),
        max_nodes=_int_param(params, "maxNodes", inspection.DEFAULT_MAX_NODES, MAX_NODES),
        include_roles=frozenset(include) if include else None,
        exclude_roles=frozenset(exclude),
    )

    def work():
        _registry.resolve(element_id)
        obj = atspi.lookup(element_id)
        if obj is None:
            raise DesktopError(
                ErrorCode.ELEMENT_NOT_FOUND,
                f"Element {element_id!r} is no longer reachable",
                {"elementId": element_id},
            )
        return inspection.inspect_tree(
            obj, describe=atspi.describe, children=atspi.children_of, bounds=bounds
        )

    result = loop.call_on_loop(work, timeout=WALK_TIMEOUT_SECONDS)
    revision = _registry.record(result.observations)
    return {
        "element": result.root.to_json(),
        "nodeCount": result.node_count,
        "truncated": result.truncated,
        "revision": revision,
        "backend": atspi.BACKEND_NAME,
    }


#: Consent and the audit log are process-wide for the same reason the registry
#: is: several clients share this service, and a permission that differed from
#: the thing it protects would be worse than no permission at all. Both are
#: replaced at startup from configuration; the defaults here are the safe ones,
#: so a service that somehow started without reading its config observes and
#: does nothing else.
_consent = security.Consent()
_audit = audit.AuditLog()


def configure(
    settings: dict[str, Any] | None,
    config_path: str = "",
    config_exists: bool | None = None,
) -> None:
    """Install the user's ceiling, redaction list and audit path.

    Called once, at startup, from the process entry point. Deliberately not
    reachable over the socket: the ceiling exists precisely because a client
    cannot be the one who decides what a client may do.
    """
    global _consent, _audit
    settings = settings or {}
    _consent = security.Consent(
        security.Ceiling.from_config(
            settings.get("scopes"),
            str(config_path or ""),
            exists=config_exists,
        )
    )
    _audit = audit.AuditLog(
        settings.get("auditPath") or None,
        enabled=bool(settings.get("audit", True)),
    )
    redaction.install(settings.get("sensitiveApplications", ()))


_action_log = actions.ActionLog()
#: One engine per service process, shared by every observer of the desktop: the settling
#: wait after an action, the reconciliation sweep, and — next — the accessibility event
#: stream. Each of them calls `_snapshot`, so each of them folds into the same picture.
_deltas = deltas.DeltaEngine(_action_log, advance=_registry.bump)


#: How many held elements get their value re-read on each observation. Sampling is not
#: free — a value is a live round trip to the toolkit — and observations happen every
#: fifty milliseconds while an action settles. Sixteen costs about as much as the window
#: enumeration already alongside it; a session that has inspected thousands of elements
#: pays exactly the same. The registry supplies the most recently shown, which is the
#: right cut: a reference nobody has touched in a hundred revisions is one nobody is
#: waiting on.
VALUE_WATCH_LIMIT = 16


def _probe_stale_subscriptions(
    previous: state.Snapshot, current: state.Snapshot
) -> list[dict[str, Any]]:
    """Detect subscribed elements that have gone since the last sample.

    Only ids present in the previous snapshot but absent from the current one
    are candidates — probing an element on its first sighting would report
    'gone' for something that was merely slow to arrive. The probe resolves
    the ambiguity the diff engine refuses to: ``sample_values`` returns empty
    for both unreachable and never-touched elements, but the registry's
    fingerprint check fails only when the element has actually changed identity
    or become unreachable.
    """
    subscribed = subscriptions.all_ids()
    if not subscribed:
        return []

    candidates = [
        eid for eid in subscribed
        if eid in previous.values and eid not in current.values
    ]
    if not candidates:
        return []

    stale: list[dict[str, Any]] = []
    for eid in candidates:
        gone = False
        try:
            _registry.resolve(eid)
            if atspi.lookup(eid) is None:
                gone = True
        except ElementReferenceStale:
            gone = True

        if gone:
            owner = current.owners.get(eid) or previous.owners.get(eid) or ("", "")
            stale.append(
                {
                    "kind": "element-stale",
                    "elementId": eid,
                    "applicationId": owner[0] or None,
                    "applicationName": owner[1] or None,
                    "summary": model.egress_value(
                        "a subscribed element is no longer reachable",
                        field=model.SUMMARY,
                        element_id=eid,
                    ),
                }
            )
            subscriptions.purge(eid)
    return stale


def _observe() -> tuple[state.Snapshot, list[dict[str, Any]]]:
    """Look at the desktop once, fold it in, and report what that changed.

    Both return values come from the same read on purpose. A caller that took a snapshot
    and then asked the engine what changed would be describing two different moments.

    Windows and the values of elements someone is holding. Windows alone was the original
    bargain and it was wrong in one specific way: writing to a text field changed nothing
    that a windows-only snapshot could see, so `setElementValue` returned success with an
    empty list of effects. Both halves of that sentence were true and together they read
    as a lie — the field really had changed, and the only way to know it was to read the
    value back by hand.

    The watch set is the union of the recency heuristic and declared subscriptions: an
    element somebody subscribed to is sampled regardless of how recently it was touched,
    because a declared intent outranks a heuristic. A subscribed element that was sampled
    before but is missing now may have gone, and is probed rather than left to silence.
    """
    watched = list(
        set(_registry.recent(VALUE_WATCH_LIMIT, roles=atspi.TEXT_VALUE_ROLES))
        | subscriptions.all_ids()
    )

    def look():
        return atspi.list_windows(), atspi.sample_values(watched), atspi.owners_of(watched)

    previous = _deltas.current
    windows, values, owners = loop.call_on_loop(look, timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS)
    snapshot = state.snapshot_from_windows(_registry.revision, windows, values, owners)
    changes = _deltas.observe(snapshot)

    stale = _probe_stale_subscriptions(previous, _deltas.current)
    if stale:
        changes.extend(_deltas.report(stale))

    return _deltas.current, changes


def _snapshot() -> state.Snapshot:
    """The desktop as the diff engine sees it, at the current revision.

    Windows only. Sampling every element of every window between two ticks of a settling
    wait would cost more than the action it is measuring, and the changes that matter for
    an action's effects — a dialog appearing, focus moving — are all visible at this
    granularity. Element-level conditions ask the backend directly instead.
    """
    # Every sample the service takes, wherever it came from, folds into the one engine. A
    # change seen only by the settling wait and never recorded would be an effect the
    # acting client is told about and every other consumer never hears of.
    return _observe()[0]


def _watch_sample() -> tuple[int, list[dict[str, Any]]]:
    snapshot, changes = _observe()
    return snapshot.revision, changes


_watcher = watch.Watcher(
    sample=_watch_sample,
    publish=lambda delta: log.info(
        "delta rev=%s changes=%s partial=%s reason=%s",
        delta.revision,
        len(delta.changes),
        delta.partial,
        delta.reason,
    ),
    schedule=loop.after,
    now_ms=lambda: int(time.monotonic() * 1000),
    # Asked, not tracked here: the actions module is the only place that knows an action
    # has been dispatched and has not finished settling.
    busy=actions.in_flight,
)


#: Who has the keyboard. Both probes go to the display server rather than the
#: toolkit: the idle timer costs a property read and no trip onto the shared loop
#: thread, which is what makes it affordable to ask between every two words of a
#: paced write.
_presence = presence.Watch(
    x11.idle_ms,
    lambda: str(x11.active_xid() or ""),
)


def _display_window_of(element_id: str) -> str:
    """The display server's id for the window this element sits in.

    Resolved once, before a write begins, because the per-word check has to be
    cheap: comparing two X ids costs a property read, while asking the
    accessibility layer which window is active would put a full desktop
    enumeration between every two words.

    Empty when the window cannot be identified — which reads, correctly, as "no
    takeover can be detected here" rather than as a takeover.
    """
    window_id, _ = _element_scope(element_id)
    if not window_id:
        return ""

    def resolve() -> int | None:
        window = atspi.find_window(window_id)
        return atspi.xid_of(window) if window is not None else None

    try:
        return str(loop.call_on_loop(resolve, timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS) or "")
    except Exception:
        return ""


def _resolve_element(element_id: str):
    """Registry check first, then the live object. Stale beats not-found."""
    _registry.resolve(element_id)
    obj = atspi.lookup(element_id)
    if obj is None:
        raise DesktopError(
            ErrorCode.ELEMENT_NOT_FOUND,
            f"Element {element_id!r} is no longer reachable",
            {"elementId": element_id},
        )
    return obj


def _settle_bounds(params: dict[str, Any]) -> dict[str, int]:
    quiet = params.get("settleMs")
    if quiet is None:
        return {}
    return {"quiet_ms": int(quiet)}


def _client_id(params: dict[str, Any]) -> str:
    """Who is asking. Load-bearing for grants, audit and attribution.

    The connection's issued identity wins whenever there is one, and over a socket
    there always is: a `clientId` in the params is a name the caller wrote for
    itself, and a name a caller can write for itself is a name it can write for
    somebody else. It survives only as a label.

    The fallback to the params is not a hole, because it is unreachable from
    outside: it exists for in-process callers and tests, which drive the handlers
    directly and have no connection to be identified by.
    """
    issued = identity.current()
    if issued:
        return issued
    value = params.get("clientId")
    return str(value) if isinstance(value, str) else ""


def _element_scope(element_id: str) -> tuple[str, str]:
    """Where an action on this element could reach, resolved before it is dispatched.

    Best effort on purpose: a scope this fails to determine makes attribution more
    cautious, never wrong. Failing the action because its blast radius could not be
    measured would trade a working action for a bookkeeping detail.
    """
    try:
        return loop.call_on_loop(
            lambda: atspi.scope_of(_resolve_element(element_id)),
            timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS,
        )
    except Exception:
        return "", ""


def _window_scope(window_id: str) -> tuple[str, str]:
    try:
        return loop.call_on_loop(
            lambda: atspi.scope_of(_require_window(window_id)),
            timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS,
        )
    except Exception:
        return window_id, ""


def _method_focus_window(params: dict[str, Any]) -> dict[str, Any]:
    """Focus through the toolkit, falling back to the window manager.

    Both tiers are real here. AT-SPI's `grabFocus` is the honest request — it asks the
    application to take focus — but on this desktop no window reports itself active
    through accessibility at all, so the EWMH path is not a theoretical fallback. It is
    load-bearing, and the result says which one answered.
    """
    window_id = _str_param(params, "windowId", required=True)

    def by_accessibility() -> bool:
        window = _require_window(window_id)
        return loop.call_on_loop(
            lambda: atspi.grab_focus(window), timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS
        )

    def by_compositor() -> bool:
        xid = loop.call_on_loop(
            lambda: atspi.xid_of(_require_window(window_id)),
            timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS,
        )
        return x11.activate(xid) if xid else False

    return actions.perform(
        "focusWindow",
        window_id,
        [
            actions.Attempt("accessibility", by_accessibility),
            actions.Attempt("compositor", by_compositor),
        ],
        _snapshot,
        _action_log,
        client_id=_client_id(params),
        scope=_window_scope(window_id),
        **_settle_bounds(params),
    )


def _method_invoke_element(params: dict[str, Any]) -> dict[str, Any]:
    """Invoke a named action, including a window frame's own actions.

    Frame actions are the point rather than a special case: a GTK4 window publishes its
    entire command set there while its element tree is four nested empty panels, so for
    those applications this is the only way in.
    """
    element_id = _str_param(params, "elementId", required=True)
    action_name = _str_param(params, "action", required=True)

    def run() -> bool:
        def work() -> bool:
            obj = _resolve_element(element_id)
            available = atspi.actions_of(obj)
            if action_name not in available:
                raise DesktopError(
                    ErrorCode.ACTION_NOT_SUPPORTED,
                    f"{element_id!r} does not expose an action named {action_name!r}",
                    # The available list travels with the error. A caller told only
                    # "not supported" has to spend another round trip finding out what
                    # is, and it already asked the question this answers.
                    {"elementId": element_id, "availableActions": available},
                )
            return atspi.do_action(obj, action_name)

        return loop.call_on_loop(work, timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS)

    return actions.perform(
        "invokeElement",
        element_id,
        [actions.Attempt("accessibility", run)],
        _snapshot,
        _action_log,
        client_id=_client_id(params),
        scope=_element_scope(element_id),
        **_settle_bounds(params),
    )


def _method_set_element_value(params: dict[str, Any]) -> dict[str, Any]:
    """Set text or a number through the toolkit's own interfaces.

    Never by synthesizing keystrokes: typing at a window assumes focus is where the
    caller believes it is, and the moment that assumption is wrong the text lands
    somewhere else entirely with no error anywhere.
    """
    element_id = _str_param(params, "elementId", required=True)
    if "value" not in params:
        raise InvalidParams("setElementValue needs a 'value'", {"parameter": "value"})
    value = params["value"]

    def run() -> bool:
        def work() -> bool:
            obj = _resolve_element(element_id)
            if isinstance(value, bool):
                # Guarded explicitly because bool is an int in Python and would
                # otherwise be set as 1 on a numeric element.
                raise InvalidParams(
                    "setElementValue takes text or a number, not a boolean",
                    {"parameter": "value"},
                )
            if isinstance(value, (int, float)):
                return atspi.set_numeric_value(obj, float(value))
            return atspi.set_text_value(obj, str(value))

        return loop.call_on_loop(work, timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS)

    return actions.perform(
        "setElementValue",
        element_id,
        [actions.Attempt("accessibility", run)],
        _snapshot,
        _action_log,
        client_id=_client_id(params),
        scope=_element_scope(element_id),
        **_settle_bounds(params),
    )


def _yielded(progress: dict[str, Any], element_id: str, window: str, client_id: str) -> bool:
    """Whether a person just took this field, checked between two words.

    Between, never during: an insert that has left for the toolkit thread cannot
    be recalled, so the finest granularity honestly available is one word. That
    is the whole cost of yielding — a person who reaches for the field mid-word
    gets one more word than they asked for, and then silence.

    The write stops and the field is withheld in the same breath, so the client
    that lost it cannot simply call again and win the race.
    """
    if not _presence.took(window):
        return False
    _presence.withhold(element_id, window, taken_from=client_id)
    progress["yieldedTo"] = "user"
    progress["stoppedBecause"] = (
        "the person at this desktop started working in that window, so the writing stopped"
    )
    return True


def _method_type_text(params: dict[str, Any]) -> dict[str, Any]:
    """Type into an element at human speed, a word at a time.

    Everything about this method is `setElementValue` with the timing put back
    in. It goes through the same editable-text interface, synthesizes no
    keystrokes, and needs no focus — which is what makes the pace a presentation
    choice rather than a trick. Text that appears all at once is text nobody
    typed, and a surprising number of applications only notice input that
    arrives the way dictation delivers it.

    Success is the field reading back what it was supposed to say. Not "the
    inserts returned true", which several toolkits will happily do while
    dropping the text on the floor, and not "the call finished in time", which
    is a statement about the clock rather than about the desktop.

    Each insert is its own short trip onto the toolkit thread and the waiting
    happens off it. A word takes under a millisecond to insert; the second it
    takes to wait belongs to nobody, and holding the one thread every client
    shares for the length of a sentence would stall the whole desktop to make
    one field look human.

    A stalled toolkit ends the typing but does not end the call. Raising there
    would throw away the part that already happened and leave half a sentence on
    somebody's screen with no record of it — so the deadline produces a report
    instead: how far it got, what the field says now, and whether waiting is
    still reasonable. The decision about what to do next is not the service's to
    make.
    """
    element_id = _str_param(params, "elementId", required=True)
    text = _str_param(params, "text", required=True)
    wpm = int(params.get("wordsPerMinute") or cadence.DEFAULT_WPM)
    replace = bool(params.get("replace", False))
    plan = cadence.plan(text, wpm=wpm)
    progress: dict[str, Any] = {
        "wordsPlanned": len(plan),
        "wordsTyped": 0,
        "estimatedMs": cadence.estimate_ms(text, wpm=wpm),
    }

    def on_loop(work):
        return loop.call_on_loop(work, timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS)

    def run() -> bool:
        def begin() -> bool:
            obj = _resolve_element(element_id)
            if not atspi.is_editable(obj):
                return False
            return atspi.set_text_value(obj, "") if replace else True

        if not on_loop(begin):
            progress["stoppedBecause"] = "the element does not accept text"
            return False

        held_window = _display_window_of(element_id)
        for stroke in plan:
            if stroke.delay_ms:
                time.sleep(stroke.delay_ms / 1000.0)
            if _yielded(progress, element_id, held_window, _client_id(params)):
                break
            try:
                landed = on_loop(lambda: atspi.insert_text(_resolve_element(element_id), stroke.text))
            except DesktopError as stalled:
                # The toolkit stopped answering. Everything typed so far is still
                # on screen, so this is a state to report rather than an
                # exception to throw.
                progress["stoppedBecause"] = f"the application stopped answering: {stalled.message}"
                break
            if not landed:
                progress["stoppedBecause"] = "the application refused an insertion"
                break
            progress["wordsTyped"] += 1

        # The one assertion that matters, made against the raw text inside the
        # backend so that a redacted field can still be confirmed.
        try:
            verdict = on_loop(
                lambda: atspi.text_matches(_resolve_element(element_id), text, exact=replace)
            )
        except DesktopError as unreachable:
            progress["verified"] = "unknown"
            progress["stoppedBecause"] = progress.get("stoppedBecause") or unreachable.message
            return False
        progress["verified"] = verdict
        if verdict == "unverifiable":
            # A password entry hands the accessibility layer a row of bullets
            # instead of its contents, so there is nothing to compare against.
            # Every word was delivered and accepted; calling that a failure
            # would invite the caller to type the password a second time.
            progress["stoppedBecause"] = progress.get("stoppedBecause") or (
                "the field masks its own contents, so what was typed cannot be read back — "
                "every word was accepted"
            )
            return not progress.get("wordsTyped", 0) < progress["wordsPlanned"]
        return verdict == "verified"

    result = actions.perform(
        "typeText",
        element_id,
        [actions.Attempt("accessibility", run)],
        _snapshot,
        _action_log,
        client_id=_client_id(params),
        scope=_element_scope(element_id),
        **_settle_bounds(params),
    )
    # Carried whether it worked or not: a caller that reads only the failures
    # learns nothing about how far a successful call had to go, and a caller
    # that reads only `ok` cannot tell a refusal from an interruption.
    result["progress"] = progress
    return result


#: How long a highlight is left up before the text under it goes. Long enough for
#: an eye to land on it, short enough that nobody is waiting on the theatre.
SELECTION_DWELL_SECONDS = 0.4


def _method_edit_text(params: dict[str, Any]) -> dict[str, Any]:
    """Replace part of a field's text, addressed by the text rather than by offsets.

    Editing at this layer is a splice: a range is removed and something is put in
    its place. There is no keyboard here, so there is nothing to press backspace
    on, and imitating one would mean forty separate edits where the application
    should see one.

    The range is found by content on purpose. Offsets are an index into a field
    somebody may have typed into since the caller last looked, and an index that
    has moved silently addresses the wrong characters — the same failure that
    made every action in this service addressed by name. Text that has moved is
    simply not found, and two matches are refused rather than guessed between.

    `showSelection` and `wordsPerMinute` are presentation. They change what a
    watching human sees and nothing about whether the edit succeeded, which is
    still only ever the field reading back what was asked for.
    """
    element_id = _str_param(params, "elementId", required=True)
    needle = _str_param(params, "find", required=True)
    replacement = params.get("replaceWith") or ""
    wpm = params.get("wordsPerMinute")
    show_selection = bool(params.get("showSelection", False))
    progress: dict[str, Any] = {"found": False}

    def on_loop(work):
        return loop.call_on_loop(work, timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS)

    def run() -> bool:
        found = on_loop(lambda: atspi.find_range(_resolve_element(element_id), needle))
        if found is None:
            progress["stoppedBecause"] = (
                "that text does not appear exactly once in the field: it may have changed, "
                "or the same text may appear more than once"
            )
            return False
        start, end = found
        progress.update({"found": True, "start": start, "end": end, "removed": end - start})

        if show_selection:
            on_loop(lambda: atspi.select_text(_resolve_element(element_id), start, end))
            time.sleep(SELECTION_DWELL_SECONDS)

        if not on_loop(lambda: atspi.delete_text(_resolve_element(element_id), start, end)):
            progress["stoppedBecause"] = "the application refused the deletion"
            return False

        if not replacement:
            verdict = on_loop(lambda: atspi.text_contains(_resolve_element(element_id), needle))
            if verdict == "unverifiable":
                progress["verified"] = verdict
                progress["stoppedBecause"] = (
                    "the field masks its own contents, so the deletion cannot be read back — "
                    "the range was removed"
                )
                return True
            progress["verified"] = "verified" if verdict == "mismatch" else "mismatch"
            return verdict == "mismatch"

        plan = cadence.plan(replacement, wpm=int(wpm)) if wpm else [cadence.Keystroke(replacement, 0)]
        progress["wordsPlanned"] = len(plan)
        progress["wordsTyped"] = 0
        offset = start
        held_window = _display_window_of(element_id)
        for stroke in plan:
            if stroke.delay_ms:
                time.sleep(stroke.delay_ms / 1000.0)
            if _yielded(progress, element_id, held_window, _client_id(params)):
                break
            try:
                landed = on_loop(
                    lambda: atspi.insert_text(_resolve_element(element_id), stroke.text, offset)
                )
            except DesktopError as stalled:
                progress["stoppedBecause"] = f"the application stopped answering: {stalled.message}"
                break
            if not landed:
                progress["stoppedBecause"] = "the application refused an insertion"
                break
            progress["wordsTyped"] += 1
            offset += len(stroke.text)

        # An edit lands in the middle of a field, so the question is whether the
        # replacement is in there — not whether the field ends with it.
        verdict = on_loop(lambda: atspi.text_contains(_resolve_element(element_id), replacement))
        progress["verified"] = verdict
        if verdict == "unverifiable":
            progress["stoppedBecause"] = progress.get("stoppedBecause") or (
                "the field masks its own contents, so what was written cannot be read back — "
                "every word was accepted"
            )
            return progress["wordsTyped"] == progress["wordsPlanned"]
        return verdict == "verified"

    result = actions.perform(
        "editText",
        element_id,
        [actions.Attempt("accessibility", run)],
        _snapshot,
        _action_log,
        client_id=_client_id(params),
        scope=_element_scope(element_id),
        **_settle_bounds(params),
    )
    result["progress"] = progress
    return result


_BATCH_METHODS = {
    "focusWindow": _method_focus_window,
    "invokeElement": _method_invoke_element,
    "setElementValue": _method_set_element_value,
    "typeText": _method_type_text,
    "editText": _method_edit_text,
}


def _method_perform_actions(params: dict[str, Any]) -> dict[str, Any]:
    requested = params.get("actions") or []
    stop_on_failure = params.get("stopOnFailure", True)

    def run_one(request: dict[str, Any]) -> dict[str, Any]:
        handler = _BATCH_METHODS.get(request.get("method", ""))
        if handler is None:
            raise InvalidParams(
                f"{request.get('method')!r} cannot appear in a batch",
                {"allowed": sorted(_BATCH_METHODS)},
            )
        try:
            return handler(request.get("params") or {})
        except DesktopError as failure:
            # A failing step inside a batch is a result, not the end of the call: the
            # caller needs to see which step failed and what the ones before it did.
            return {
                "actionId": "failed",
                "ok": False,
                "backend": atspi.BACKEND_NAME,
                "fallbacksUsed": [],
                "durationMs": 0,
                "error": {
                    "code": failure.code,
                    "message": failure.message,
                    "detail": failure.detail,
                },
            }

    outcome = actions.perform_batch(run_one, requested, stop_on_failure)
    return {**outcome, "revision": _registry.revision}


def _method_wait_for(params: dict[str, Any]) -> dict[str, Any]:
    condition = waitfor.Condition(
        kind=_str_param(params, "condition", required=True),
        window_id=_str_param(params, "windowId") or "",
        element_id=_str_param(params, "elementId") or "",
        role=_str_param(params, "role") or "",
        name=_str_param(params, "name") or "",
        state_name=_str_param(params, "state") or "",
        revision=int(params.get("revision") or 0),
    )
    timeout_ms = _int_param(params, "timeoutMs", waitfor.DEFAULT_TIMEOUT_MS, 120_000)

    def find_element(want: waitfor.Condition) -> dict[str, Any] | None:
        if not want.window_id:
            return None

        def work():
            window = _require_window(want.window_id)
            return inspection.query(
                window,
                describe=atspi.describe,
                children=atspi.children_of,
                role=want.role or None,
                name=want.name or None,
                states=frozenset([want.state_name]) if want.state_name else frozenset(),
                limit=1,
            )

        found = loop.call_on_loop(work, timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS)
        if not found.matches:
            return None
        _registry.record(found.observations)
        match = found.matches[0]
        return {
            "kind": "element-appeared"
            if want.kind == "element-appeared"
            else "element-state-changed",
            "revision": _registry.revision,
            "windowId": want.window_id,
            "elementId": match.id,
            "summary": f"{match.role} {match.name!r} satisfied the wait",
        }

    return waitfor.wait(condition, _snapshot, find_element, timeout_ms=timeout_ms)


def _method_get_revision(_params: dict[str, Any]) -> dict[str, Any]:
    return {"revision": _registry.revision, "observationMode": _session.mode}


def _method_get_delta_since(params: dict[str, Any]) -> dict[str, Any]:
    """What this caller missed, in this caller's terms.

    The desktop is sampled first rather than answered from the last thing the watcher
    happened to notice: a caller asking right now wants the truth as of now, not the truth
    as of the debounce that has not fired yet. The sample folds into the same engine the
    push lane reads, so polling and listening cannot diverge.
    """
    _snapshot()
    delta = _deltas.since(int(params["sinceRevision"]), _client_id(params))
    # A walled-off application does not announce itself either. The engine
    # still recorded the change — its picture of the desktop has to stay whole
    # or the next revision would be computed against a fiction — but a caller
    # who may not see the window does not get told the window moved.
    # ...and a client watching one application is not told about the others.
    # That is the same filter, one predicate later: the wall decides what may be
    # seen, the client decides what it wants of that.
    delta["changes"] = _visible(
        params, delta.get("changes") or [], "applicationName", "applicationId"
    )
    if not delta["complete"]:
        delta["resumeRevision"] = _deltas.resume_revision
    return delta


def _method_get_desktop_state(params: dict[str, Any]) -> dict[str, Any]:
    """The whole current picture — what a caller reads to re-acquire after a gap."""
    snapshot = _snapshot()
    windows = _visible(
        params,
        [
            {
                "windowId": window.window_id,
                "applicationId": window.application_id,
                "applicationName": window.application_name,
                "title": window.title,
                "role": window.role,
                "active": window.active,
            }
            for window in snapshot.windows.values()
        ],
        "applicationName",
        "applicationId",
    )
    visible = {window["windowId"] for window in windows}
    return {
        "windows": windows,
        # The active window is a window like any other. Naming it while
        # withholding it from the list would answer "is the password manager
        # in front right now". Empty is already this field's word for nothing
        # holding focus, and from out here the two are indistinguishable. To a
        # client watching one application it reads as "nothing you are watching
        # is in front", which is the truthful answer to what it asked.
        "activeWindowId": (
            snapshot.active_window if snapshot.active_window in visible else ""
        ),
        "revision": snapshot.revision,
        "observationMode": _session.mode,
    }


def _method_capture_window(params: dict[str, Any]) -> dict[str, Any]:
    """Hand back the pixels of one window, or refuse the whole application.

    The refusal is checked before the display server is asked for anything, because a
    capture that is taken and then discarded has already been taken. And it is checked
    against the application rather than the window: pixels cannot be redacted the way a
    value can, so the only honest gate is one that produces no image at all.
    """
    window_id = _str_param(params, "windowId", required=True)
    max_width = params.get("maxWidth")
    if max_width is not None and (not isinstance(max_width, int) or isinstance(max_width, bool)):
        raise InvalidParams(
            "'maxWidth' must be an integer",
            {"parameter": "maxWidth", "received": type(max_width).__name__},
        )

    if not capture.available():
        raise DesktopError(
            ErrorCode.BACKEND_UNAVAILABLE,
            "This desktop cannot produce window captures",
            {"reason": capture.unavailable_reason()},
        )

    def locate() -> tuple[int, str]:
        window = _require_window(window_id)
        return (atspi.xid_of(window) or 0, atspi.application_name_of(window))

    xid, application_name = loop.call_on_loop(locate, timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS)

    refusal = policy.capture_refusal(application_name)
    if refusal:
        raise DesktopError(
            ErrorCode.PERMISSION_DENIED,
            refusal,
            {"windowId": window_id, "hint": "the blocklist is configuration, not a request"},
        )

    if xid <= 0:
        raise DesktopError(
            ErrorCode.WINDOW_NOT_FOUND,
            f"The display server has no window matching {window_id!r}",
            {
                "windowId": window_id,
                "hint": "the accessibility layer knows this window; the display server does not",
            },
        )

    try:
        image = capture.capture(xid, max_width)
    except Exception as exc:  # the window went away, or the display server refused
        raise DesktopError(
            ErrorCode.BACKEND_UNAVAILABLE,
            f"The display server would not produce pixels for {window_id!r}",
            {"windowId": window_id, "detail": str(exc)},
        ) from exc

    return {
        "windowId": window_id,
        "format": "png",
        "image": image.encoded(),
        "width": image.width,
        "height": image.height,
        "capturedWidth": image.captured_width,
        "capturedHeight": image.captured_height,
        "frameCropped": image.frame_cropped,
        "scaled": image.scaled,
        "backend": capture.BACKEND,
        "revision": _registry.revision,
    }


def _method_grant_scope(params: dict[str, Any]) -> dict[str, Any]:
    """Move the hand, never the ceiling.

    The ceiling comes back on every answer, including the successful ones. A
    client that asked for edit and got it still benefits from knowing whether
    submit was ever going to be available, because the alternative is finding
    out one method call before it mattered.

    The grant is filed under the same identity the guard will ask about — the
    one the connection was issued, not the one the caller wrote down. Filing it
    under a claimed name was the whole hole A12 closed, and it would reappear
    here as a grant that is real, recorded, and consulted for nobody.
    """
    classes = params.get("operationClasses") or []
    grant = _consent.grant(
        _client_id(params),
        classes=classes,
        applications=params.get("applications") or (),
        seconds=params.get("seconds"),
        reason=params.get("reason") or "",
    )
    return {
        "operationClasses": sorted(grant.classes),
        "applications": sorted(grant.applications),
        "expiresInSeconds": int(grant.idle_seconds),
        "ceiling": sorted(_consent.ceiling.classes),
    }


def _method_emergency_stop(params: dict[str, Any]) -> dict[str, Any]:
    """Stop meaning everything from here on, which is all a stop can mean.

    `inFlight` is reported rather than acted on. An action already dispatched to
    a toolkit is on its way to an application that has never heard of this
    service, and counting them honestly is more use to whoever is reading than
    a claim to have cancelled them.
    """
    if params.get("clear"):
        _consent.clear_stop()
        return {"stopped": False, "grantsRevoked": 0, "inFlight": actions.in_flight_count()}
    in_flight = actions.in_flight_count()
    revoked = _consent.emergency_stop(params.get("reason") or "")
    return {"stopped": True, "grantsRevoked": revoked, "inFlight": in_flight}


def _method_audit_tail(params: dict[str, Any]) -> dict[str, Any]:
    limit = params.get("limit") or 20
    health = _audit.health()
    return {
        "entries": _audit.tail(int(limit)),
        "path": health["path"],
        "written": health["written"],
        "writeFailures": health["writeFailures"],
    }


def _method_list_installable_applications(_params: dict[str, Any]) -> dict[str, Any]:
    applications = loop.call_on_loop(launcher.list_installable)
    return {
        "applications": applications,
        "backend": launcher.BACKEND_NAME,
        "revision": _registry.revision,
    }


def _method_launch_application(params: dict[str, Any]) -> dict[str, Any]:
    """Start an application, and report the window it produced as this action's doing.

    The id is checked against the enumeration before anything is attempted. Refusing an
    unknown id is not defensive tidiness: the enumeration is what makes this method a
    launcher rather than an executor, and a launch that fell back to trying the string
    some other way would quietly give that guarantee up.
    """
    entry_id = _str_param(params, "applicationEntryId", required=True)

    if not loop.call_on_loop(lambda: launcher.exists(entry_id)):
        raise DesktopError(
            ErrorCode.APPLICATION_NOT_FOUND,
            f"No installed application has the entry id {entry_id!r}",
            {
                "applicationEntryId": entry_id,
                "hint": "ids come from listInstallableApplications",
            },
        )

    watch = _LaunchWatch()

    def start() -> bool:
        watch.pid = loop.call_on_loop(lambda: launcher.launch(entry_id))
        return watch.pid > 0

    bounds = _settle_bounds(params)
    bounds.setdefault("ceiling_ms", LAUNCH_CEILING_MS)
    result = actions.perform(
        "launchApplication",
        entry_id,
        [actions.Attempt(launcher.BACKEND_NAME, start)],
        _snapshot,
        _action_log,
        client_id=_client_id(params),
        # Empty on purpose: a launch has no target window to be scoped to yet. The
        # scope is adopted below, from the window the launch was seen to open — the
        # one case where an action's causal scope is only knowable after the fact.
        scope=("", ""),
        until=watch.window_arrived,
        **bounds,
    )
    _adopt_launched_scope(result, watch)
    return result


#: A cold start is slower than any interaction, and slower than the settling ceiling that
#: fits one. Still under the client's request timeout, so a launch that never opens a
#: window comes back as an honest empty result rather than a dead socket.
LAUNCH_CEILING_MS = 10000


class _LaunchWatch:
    """Recognises the window a launch opened, by process rather than by timing.

    The temptation is to claim the first window that appears after a launch. That is the
    exact mistake attribution exists to prevent: a window the user opened while an
    application was starting would be claimed by the agent, and the agent would go on to
    act inside it believing it was its own. So the test is descent from the process we
    started — identity, with the ceiling only bounding how long we are willing to wait
    for it.

    A launch that yields no process id claims nothing. That happens for D-Bus activated
    applications, where the bus starts the program and does not report whose it is; the
    honest consequence is that the window arrives as `external` and the agent has to look
    for it, which is worse than claiming it and far better than claiming the wrong one.
    """

    def __init__(self) -> None:
        self.pid = 0
        self.window_id = ""
        self.application_id = ""
        self._before: state.Snapshot | None = None

    def window_arrived(self, snapshot: state.Snapshot) -> bool:
        if self._before is None:
            self._before = snapshot
            return False
        if self.window_id:
            return True
        if self.pid <= 0:
            # Nothing to recognise. Waiting would only delay an answer we cannot improve.
            return True
        fresh = [
            facts for window_id, facts in snapshot.windows.items()
            if window_id not in self._before.windows
        ]
        if not fresh:
            return False
        owners = loop.call_on_loop(atspi.application_pids)
        for facts in fresh:
            if launcher.descends_from(owners.get(facts.application_id, 0), self.pid):
                self.window_id = facts.window_id
                self.application_id = facts.application_id
                return True
        return False


def _adopt_launched_scope(result: dict[str, Any], watch: _LaunchWatch) -> None:
    """Claim the window a launch opened, so later changes in it read as this agent's.

    Without this the application the agent just started would announce itself to that
    same agent as somebody else's news. A launch that opened no window this service can
    claim claims nothing: the scope stays empty, and the window is attributed to whoever
    it actually belongs to rather than to whoever happened to be acting.
    """
    if not watch.window_id:
        return
    record = _action_log.latest()
    if record is None or record.action_id != result.get("actionId"):
        return
    record.scope_window_id = watch.window_id
    record.scope_application_id = watch.application_id


def _method_set_observation_mode(params: dict[str, Any]) -> dict[str, Any]:
    return {**_session.set_observation_mode(params), "revision": _registry.revision}


def _claim_payload(hold: holds.Hold) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "elementId": hold.element_id,
        "clientId": hold.client_id,
        "expiresInMs": hold.expires_in_ms(),
        "leaseMs": hold.lease_ms or 0,
        "heldForMs": hold.held_for_ms(),
    }
    if hold.client_label:
        payload["clientLabel"] = hold.client_label
    if hold.reason:
        payload["reason"] = hold.reason
    return payload


def _method_claim_element(params: dict[str, Any]) -> dict[str, Any]:
    """Take an element for the length of a piece of work rather than one call.

    The element is resolved before it is claimed. Claiming an id that names
    nothing would hand a caller a lease over a field that does not exist and let
    it discover the truth one call later, having meanwhile refused everybody
    else.

    The lease comes from the work: an estimate, or the text about to be typed
    run through the same arithmetic the typing will use. Nothing here trusts the
    caller's clock — `estimatedWorkMs` is what the caller *believes*, and the
    ceiling is what it gets.
    """
    element_id = _str_param(params, "elementId", required=True) or ""
    _resolve_element(element_id)

    for_text = _str_param(params, "forText")
    words_per_minute = params.get("wordsPerMinute")
    estimated = params.get("estimatedWorkMs")
    lease_ms = holds.lease_for(
        estimated if isinstance(estimated, int) else None,
        for_text=for_text,
        words_per_minute=words_per_minute if isinstance(words_per_minute, int) else None,
    )
    hold = holds.claim(
        element_id,
        _client_id(params),
        lease_ms=lease_ms,
        reason=_str_param(params, "reason") or "",
    )
    return {"claim": _claim_payload(hold), "revision": _registry.revision}


def _method_release_element(params: dict[str, Any]) -> dict[str, Any]:
    """Give a claimed element back.

    Deliberately does not resolve the element first. A claim on something that
    has since gone away is exactly the claim most worth releasing, and refusing
    to let go of it because the field is missing would leave the element owned
    by a caller who cannot ever release it.
    """
    element_id = _str_param(params, "elementId", required=True) or ""
    client_id = _client_id(params)
    released = holds.release(element_id, holder_id=client_id)
    result: dict[str, Any] = {
        "released": released is not None,
        "revision": _registry.revision,
    }
    if released is not None:
        result["heldForMs"] = released.held_for_ms()
    return result


def _method_subscribe_element(params: dict[str, Any]) -> dict[str, Any]:
    """Declare that this connection wants to be told about this element.

    A subscription is an observation claim, not a write claim: it changes who is
    watching, not who may touch. Subscribing to an id that names nothing is an
    unkeepable promise, so the element is resolved first — the way a claim is.

    Over the ceiling is a refusal that names the ceiling, never a silent
    truncation: a service that accepted a thousand subscriptions and quietly
    sampled the first sixteen would have reinvented the bug this method exists
    to fix.
    """
    _resolve_element(_str_param(params, "elementId"))
    subscriptions.declare(_client_id(params), _str_param(params, "elementId"))
    return {"subscribed": True, "revision": _registry.revision}


def _method_unsubscribe_element(params: dict[str, Any]) -> dict[str, Any]:
    """Drop this connection's subscription to an element.

    Releasing what you do not subscribe to is not an error, for the same reason
    releasing an unclaimed element is not: the connection ends up in the right
    state either way.
    """
    released = subscriptions.release(_client_id(params), _str_param(params, "elementId"))
    return {"released": released, "revision": _registry.revision}


def _method_set_attention(params: dict[str, Any]) -> dict[str, Any]:
    """Record what this connection is looking at.

    Deliberately a whole declaration rather than a set of adjustments: a client
    that sends only `depth` has also said "every application", because a view
    assembled out of remembered fragments is a view nobody can reason about from
    either end. Sending nothing therefore returns the connection to the desktop,
    which is where it started.

    Nothing here is a permission. Naming an application the user walled off
    stores the name and shows the client nothing, because the ceiling has
    already removed those rows by the time attention is consulted.
    """
    applications = params.get("applications")
    if applications is not None and not isinstance(applications, list):
        raise InvalidParams(
            "'applications' must be an array of names when provided",
            {"received": type(applications).__name__},
        )
    declared = attention.declare(
        _client_id(params),
        applications or (),
        _str_param(params, "depth") or attention.SURFACE,
    )
    return {
        "applications": list(declared.declared),
        "depth": declared.depth,
        # What the declaration actually bought. A client that asked to go deep
        # without naming an application learns here that it did not, instead of
        # finding out from a truncated tree.
        "maxDepth": declared.depth_ceiling(MAX_DEPTH, SCOPED_MAX_DEPTH),
        "revision": _registry.revision,
    }


_PR_SET_PDEATHSIG = 1


def _die_with_parent() -> None:
    """Ask the kernel to SIGTERM this process when its parent goes away.

    The service is a child of the plugin, not a daemon, and a plugin can be
    killed in ways that run no cleanup code. Without this, every agent run that
    starts a service leaks one — which is exactly what happened the first time
    this ran under `mcdf`.
    """
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(_PR_SET_PDEATHSIG, signal.SIGTERM)
    except (OSError, AttributeError):
        return
    # If the parent died between the fork and the prctl call, the signal we just
    # armed will never arrive. Check for the orphaned case directly.
    if os.getppid() == 1:
        os.kill(os.getpid(), signal.SIGTERM)


def _validated(method: str, handler):
    """Enforce the frozen schema on both directions before and after a handler runs.

    Applied once at registration rather than inside each handler, so a new method
    cannot be added without validation by forgetting a line. The response half
    matters as much as the request half: a generated result schema that nothing
    ever checks is a contract in name only.
    """

    def call(params: dict[str, Any]) -> dict[str, Any]:
        return validate_result(method, handler(validate_params(method, params)))

    return call


def _text(value: Any, limit: int = 200) -> str:
    """A string, or nothing, from a value the schema has not vetted yet.

    Bounded because these go into the audit log: a caller that sent a megabyte
    where an id belongs would otherwise write a megabyte to disk per call, and
    do it through the component whose job is to be trustworthy.
    """
    return value[:limit] if isinstance(value, str) else ""


def _application_of(params: dict[str, Any]) -> str:
    """Which application this call is aimed at, if the rules need to know.

    Resolved lazily and only when a rule actually depends on it. A per-call
    window lookup on the toolkit thread to satisfy an allowlist nobody
    configured would be a tax every call pays for a question nobody asked.
    """
    window_id = params.get("windowId")
    element_id = params.get("elementId")
    target = window_id if isinstance(window_id, str) and window_id else element_id
    if not isinstance(target, str) or not target:
        return ""

    def resolve() -> str:
        obj = atspi.find_window(target) if target == window_id else atspi.lookup(target)
        return atspi.application_name_of(obj) if obj is not None else ""

    try:
        return loop.call_on_loop(resolve, timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS)
    except Exception:
        # A window that has gone away is not a permission question. Let the
        # handler produce the real error rather than answering it here — but
        # never fall through to "allowed" on a target we could not identify
        # while a list is in force.
        return _UNIDENTIFIED


#: What an application resolves to when the desktop could not say. Treated as a
#: name so that an allowlist refuses it: a call whose target cannot be
#: identified while the user has restricted which applications may be touched
#: is exactly the call that should not proceed.
_UNIDENTIFIED = "\x00unidentified"


def _needs_application(operation_class: str) -> bool:
    ceiling = _consent.ceiling
    if ceiling.blocked_applications or ceiling.applications:
        return True
    return False


#: Methods whose parameters carry other calls inside them. A batch reaches the
#: desktop through its steps, and a step's target is not visible in the
#: parameters the batch itself was checked against — so a rule about which
#: application may be touched would be checked against a call that touches
#: none. Derived from the schema rather than listed here, because a second
#: nesting method added next year would otherwise arrive unguarded and nothing
#: would say so.
_NESTING_METHODS = frozenset(
    name
    for name, schema in protocol_generated.PARAMS_SCHEMA.items()
    if isinstance(((schema.get("properties") or {}).get("actions") or {}).get("items"), dict)
    and "method" in (
        ((schema["properties"]["actions"]["items"]).get("properties") or {})
    )
)


def _enforce_nested(method: str, params: dict[str, Any], client_id: str) -> None:
    """Check a batch's steps before any of them runs.

    The whole batch is refused when one step is, rather than the batch running
    until it hits the refusal. A caller who is not allowed to touch an
    application should not discover that halfway through a sequence, with the
    first half already done and no way to say what state the desktop is now in.
    """
    if method not in _NESTING_METHODS:
        return
    steps = params.get("actions")
    if not isinstance(steps, list):
        return
    for step in steps:
        if not isinstance(step, dict):
            continue
        inner = step.get("method")
        if not isinstance(inner, str) or not inner:
            continue
        inner_params = step.get("params")
        inner_class = protocol_generated.OPERATION_CLASS.get(inner, "submit")
        _consent.enforce(
            method=inner,
            operation_class=inner_class,
            client_id=client_id,
            application=(
                _application_of(inner_params)
                if isinstance(inner_params, dict) and _needs_application(inner_class)
                else ""
            ),
            # The batch carried the confirmation. Asking for it again per step
            # would make a confirmed batch impossible to express.
            confirmed=bool(params.get("confirm")),
        )
        if isinstance(inner_params, dict):
            _enforce_presence(inner_class, inner_params)


#: Operation classes that put something into an element rather than reading it.
#: Observation is never refused on presence grounds: a person taking a field is a
#: reason to stop writing in it, not a reason to go blind.
_WRITING_CLASSES = frozenset({"edit", "submit", "destructive"})


def _enforce_presence(operation_class: str, params: dict[str, Any]) -> None:
    """Refuse to write into an element the person at the keyboard has taken.

    The withdrawal is the point. An agent that could be *asked* to stop would be
    an agent that could decline, or fail to check, or check between the wrong two
    words — so it is not asked. Its next action fails, and the failure names who
    has the field.

    The claim is on the element, not the client that lost it: a second agent
    picking up where the first left off is the same intrusion wearing a different
    name.
    """
    if operation_class not in _WRITING_CLASSES:
        return
    element_id = params.get("elementId")
    if not isinstance(element_id, str) or not element_id:
        return
    held = _presence.holder_of(element_id)
    if held is None:
        return
    raise DesktopError(
        ErrorCode.PERMISSION_DENIED,
        "The person at this desktop is using that field. It is theirs until they leave it.",
        {
            "elementId": element_id,
            "windowId": held.window_id,
            "takenFrom": held.taken_from,
            "remedy": (
                "Nothing over this socket hands it back. Wait, observe, and try again "
                "once they have moved on."
            ),
        },
    )


def _guarded(method: str, handler):
    """Consent, then the call, then the record — including when it is refused.

    This wraps registration for the same reason validation does: enforcement a
    handler has to remember to ask for is enforcement that will eventually be
    forgotten in exactly one handler, and that handler will be the interesting
    one. The model is never the thing standing between a request and a
    sensitive application.
    """
    operation_class = protocol_generated.OPERATION_CLASS.get(method, "submit")

    def call(params: dict[str, Any]) -> dict[str, Any]:
        # Every read here is defensive: this runs before the schema check, so a
        # field may be missing, of the wrong type, or hostile. Anything that is
        # not the shape we expect is treated as absent, which fails towards
        # refusing rather than towards allowing.
        client_id = _client_id(params)
        application = _application_of(params) if _needs_application(operation_class) else ""
        record = audit.Record(
            method=method,
            operation_class=operation_class,
            client_id=client_id,
            client_label=identity.current_label() or identity.label_of(params.get("clientId")),
            decision="allowed",
            application=application,
            window_id=_text(params.get("windowId")),
            element_id=_text(params.get("elementId")),
        )
        started = time.monotonic()
        try:
            _consent.enforce(
                method=method,
                operation_class=operation_class,
                client_id=client_id,
                application=application,
                confirmed=bool(params.get("confirm")),
            )
            _enforce_presence(operation_class, params)
            _enforce_nested(method, params, client_id)
        except DesktopError as denial:
            record.decision = "denied"
            record.reason = denial.message
            record.error_code = denial.code
            _audit.write(record)
            raise

        try:
            result = handler(params)
        except DesktopError as failure:
            record.decision = "failed"
            record.error_code = failure.code
            record.reason = failure.message
            record.duration_ms = int((time.monotonic() - started) * 1000)
            _audit.write(record)
            raise
        record.duration_ms = int((time.monotonic() - started) * 1000)
        _absorb_result(record, result)
        _audit.write(record)
        return result

    return call


def _absorb_result(record: audit.Record, result: dict[str, Any]) -> None:
    """Copy the facts of an outcome onto its record, and none of its contents.

    Explicitly a whitelist. Handing the whole result to the log would put the
    text of every field an agent ever read onto somebody's disk, which is the
    one sink the redaction policy cannot reach after the fact.
    """
    if not isinstance(result, dict):
        return
    backend = result.get("backend")
    if isinstance(backend, str):
        record.backend = backend
    fallbacks = result.get("fallbacksUsed")
    if isinstance(fallbacks, list):
        record.fallbacks = tuple(str(item) for item in fallbacks)
    effects = result.get("observedEffects")
    if isinstance(effects, dict):
        record.from_revision = int(effects.get("fromRevision") or 0)
        record.to_revision = int(effects.get("toRevision") or 0)
    elif isinstance(result.get("revision"), int):
        record.to_revision = result["revision"]


def build_server(socket_path: str) -> JsonRpcServer:
    # Attention dies with the connection that declared it. Identities are never
    # reused, so a survivor could not be inherited by a later client — it would
    # just accumulate, one entry per connection, in a process meant to run for
    # weeks. Subscriptions die with their connection for the same reason.
    def _on_disconnect(client_id: str) -> None:
        attention.forget(client_id)
        subscriptions.forget(client_id)

    base = JsonRpcServer(socket_path, on_disconnect=_on_disconnect)

    class _ValidatingServer:
        """Registers every handler behind its schema check."""

        def __init__(self, target: JsonRpcServer) -> None:
            self.target = target

        def register(self, method: str, handler) -> None:
            # Consent outside validation, deliberately. A client that may not do
            # this at all should not be told to fix its parameters first and
            # denied on the second attempt; the answer to both requests is the
            # same, and the schema it would be correcting against is public
            # anyway. The guard therefore reads parameters that have not been
            # checked yet, and treats anything of the wrong shape as absent.
            self.target.register(method, _guarded(method, _validated(method, handler)))

    server = _ValidatingServer(base)
    server.register("hello", _session.hello)
    server.register("setObservationMode", _method_set_observation_mode)
    server.register("setAttention", _method_set_attention)
    server.register("getDesktopCapabilities", _method_capabilities)
    server.register("listApplications", _method_list_applications)
    server.register("listWindows", _method_list_windows)
    server.register("inspectWindow", _method_inspect_window)
    server.register("queryElements", _method_query_elements)
    server.register("getElement", _method_get_element)
    server.register("getRevision", _method_get_revision)
    server.register("inspectElement", _method_inspect_element)
    server.register("focusWindow", _method_focus_window)
    server.register("invokeElement", _method_invoke_element)
    server.register("claimElement", _method_claim_element)
    server.register("releaseElement", _method_release_element)
    server.register("subscribeElement", _method_subscribe_element)
    server.register("unsubscribeElement", _method_unsubscribe_element)
    server.register("setElementValue", _method_set_element_value)
    server.register("typeText", _method_type_text)
    server.register("editText", _method_edit_text)
    server.register("performActions", _method_perform_actions)
    server.register("waitFor", _method_wait_for)
    server.register("getDeltaSince", _method_get_delta_since)
    server.register("getDesktopState", _method_get_desktop_state)
    server.register("listInstallableApplications", _method_list_installable_applications)
    server.register("launchApplication", _method_launch_application)
    server.register("captureWindow", _method_capture_window)
    server.register("grantScope", _method_grant_scope)
    server.register("emergencyStop", _method_emergency_stop)
    server.register("auditTail", _method_audit_tail)
    return base


def _start_watching() -> None:
    """Attach the watcher to the desktop's own event stream.

    Registration happens on the loop thread because that is the thread AT-SPI was
    initialised on and the thread its events are delivered to. A failure here is not
    fatal: the sweep still runs, so the service degrades to a slower account of the
    desktop rather than to no account of it — and it says which one is happening.
    """
    try:
        loop.call_on_loop(atspi.watch_events, _watcher.hint)
        log.info("watching %s desktop events", len(atspi.WATCHED_EVENTS))
    except Exception:
        log.exception("could not subscribe to desktop events; falling back to the sweep")
    loop.call_on_loop(_watcher.start_sweep)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="desktop_service")
    parser.add_argument("--socket", default=None, help="Unix socket path to listen on")
    parser.add_argument("--session", default=None, help="Session name for the default socket path")
    parser.add_argument(
        "--daemon",
        action="store_true",
        help="Listen on the shared daemon socket and outlive the process that started it",
    )
    parser.add_argument(
        "--config",
        default=None,
        help="Path to the consent configuration. Defaults to $XDG_CONFIG_HOME/mastracode-desktop/config.json",
    )
    args = parser.parse_args(argv)

    # Before anything is listening. A window between the socket opening and the
    # ceiling being installed is a window in which the defaults are wrong in
    # the permissive direction, and it would be a rare one, which is worse.
    config_path = Path(args.config) if args.config else config.default_path()
    try:
        configure(config.load(args.config), str(config_path), config_path.exists())
    except ValueError as error:
        print(f"desktop_service: {error}", file=sys.stderr)
        return 2

    if args.daemon:
        socket_path = args.socket or transport.daemon_socket_path()
    else:
        socket_path = args.socket or default_socket_path(args.session)

    # A supervised service dies with its supervisor so a crashed client cannot
    # leak a desktop service. A daemon is nobody's child: it was started to
    # outlive whatever launched it, and inheriting that death would make it
    # exactly as short-lived as the shell that ran it.
    if not args.daemon:
        _die_with_parent()
    loop.get_loop().start()
    _start_watching()
    server = build_server(socket_path)
    server.start()

    # The supervisor waits for this line before sending its first request.
    print(f"listening {socket_path}", flush=True)

    stop = threading.Event()

    def handle_signal(_signum, _frame) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    try:
        stop.wait()
    finally:
        server.stop()
        loop.get_loop().stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
