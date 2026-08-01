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
from typing import Any

from . import actions, capabilities, deltas, inspect as inspection, state, waitfor, watch
from .backends import atspi, launcher, loop, x11
from .errors import DesktopError, ErrorCode, InvalidParams
from .registry import ElementRegistry
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


def _method_capabilities(_params: dict[str, Any]) -> dict[str, Any]:
    return capabilities.build_report(
        lambda: loop.call_on_loop(atspi.probe_desktop, timeout=10.0),
        session_token=_session.token,
        observation_mode=_session.mode,
    )


def _method_list_applications(_params: dict[str, Any]) -> dict[str, Any]:
    applications = loop.call_on_loop(atspi.list_applications)
    return {"applications": applications, "backend": atspi.BACKEND_NAME}


def _method_list_windows(params: dict[str, Any]) -> dict[str, Any]:
    application_id = params.get("applicationId")
    if application_id is not None and not isinstance(application_id, str):
        raise InvalidParams(
            "'applicationId' must be a string when provided",
            {"received": type(application_id).__name__},
        )
    windows = loop.call_on_loop(atspi.list_windows, application_id)
    return {"windows": windows, "backend": atspi.BACKEND_NAME}


MAX_DEPTH = 12
MAX_NODES = 1000
MAX_QUERY_LIMIT = 200


def _method_inspect_window(params: dict[str, Any]) -> dict[str, Any]:
    window_id = _str_param(params, "windowId", required=True)
    include = params.get("includeRoles")
    exclude = params.get("excludeRoles") or []
    bounds = inspection.Bounds(
        depth=_int_param(params, "depth", inspection.DEFAULT_DEPTH, MAX_DEPTH),
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

    def work():
        window = _require_window(window_id)
        return inspection.query(
            window,
            describe=atspi.describe,
            children=atspi.children_of,
            role=role,
            name=name,
            states=states,
            limit=limit,
        )

    found = loop.call_on_loop(work, timeout=WALK_TIMEOUT_SECONDS)
    revision = _registry.record(found.observations)
    return {
        "elements": [m.to_json() for m in found.matches],
        "matchCount": len(found.matches),
        "searchTruncated": found.truncated,
        "moreResults": found.more,
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
    sits below the maximum legal depth of 12, so no permitted window inspection can reach
    it. Raising the cap would make every inspection more expensive to fix a problem about
    where the walk starts.

    The anchor is resolved through the registry first, so drilling from a reference whose
    element has been rebuilt raises `ELEMENT_REFERENCE_STALE` — with re-resolution — in
    exactly the way every other method does, instead of quietly walking a neighbour that
    happens to look similar.
    """
    element_id = _str_param(params, "elementId", required=True)
    include = params.get("includeRoles")
    exclude = params.get("excludeRoles") or []
    bounds = inspection.Bounds(
        depth=_int_param(params, "depth", inspection.DEFAULT_DEPTH, MAX_DEPTH),
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


_action_log = actions.ActionLog()
#: One engine per service process, shared by every observer of the desktop: the settling
#: wait after an action, the reconciliation sweep, and — next — the accessibility event
#: stream. Each of them calls `_snapshot`, so each of them folds into the same picture.
_deltas = deltas.DeltaEngine(_action_log, advance=_registry.bump)


def _observe() -> tuple[state.Snapshot, list[dict[str, Any]]]:
    """Look at the desktop once, fold it in, and report what that changed.

    Both return values come from the same read on purpose. A caller that took a snapshot
    and then asked the engine what changed would be describing two different moments.
    """
    windows = loop.call_on_loop(atspi.list_windows, timeout=SINGLE_ELEMENT_TIMEOUT_SECONDS)
    snapshot = state.snapshot_from_windows(_registry.revision, windows)
    return snapshot, _deltas.observe(snapshot)


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
    """Who is asking. Optional in the protocol, load-bearing for attribution.

    A client that does not name itself gets an empty id, which is a real identity here
    rather than a missing one: two anonymous clients are indistinguishable and will see
    each other's actions as their own. That is a consequence of not identifying yourself,
    not a defect in the engine.
    """
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


_BATCH_METHODS = {
    "focusWindow": _method_focus_window,
    "invokeElement": _method_invoke_element,
    "setElementValue": _method_set_element_value,
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
    if not delta["complete"]:
        delta["resumeRevision"] = _deltas.resume_revision
    return delta


def _method_get_desktop_state(params: dict[str, Any]) -> dict[str, Any]:
    """The whole current picture — what a caller reads to re-acquire after a gap."""
    snapshot = _snapshot()
    return {
        "windows": [
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
        "activeWindowId": snapshot.active_window,
        "revision": snapshot.revision,
        "observationMode": _session.mode,
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


def build_server(socket_path: str) -> JsonRpcServer:
    base = JsonRpcServer(socket_path)

    class _ValidatingServer:
        """Registers every handler behind its schema check."""

        def __init__(self, target: JsonRpcServer) -> None:
            self.target = target

        def register(self, method: str, handler) -> None:
            self.target.register(method, _validated(method, handler))

    server = _ValidatingServer(base)
    server.register("hello", _session.hello)
    server.register("setObservationMode", _method_set_observation_mode)
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
    server.register("setElementValue", _method_set_element_value)
    server.register("performActions", _method_perform_actions)
    server.register("waitFor", _method_wait_for)
    server.register("getDeltaSince", _method_get_delta_since)
    server.register("getDesktopState", _method_get_desktop_state)
    server.register("listInstallableApplications", _method_list_installable_applications)
    server.register("launchApplication", _method_launch_application)
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
    args = parser.parse_args(argv)

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
