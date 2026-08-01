"""Method registry and process entry point.

This module is the seam between the protocol and the desktop: it owns the method
table, and every handler that needs the desktop goes through `call_on_loop`. It
imports no toolkit binding of its own.
"""

from __future__ import annotations

import argparse
import ctypes
import os
import signal
import sys
import threading
from typing import Any

from . import capabilities, inspect as inspection
from .backends import atspi, loop
from .errors import DesktopError, ErrorCode, InvalidParams
from .registry import ElementRegistry
from .transport import JsonRpcServer, default_socket_path

# One registry per service process: element ids and the revision counter are
# session-scoped, and the session is the process.
_registry = ElementRegistry(prober=atspi.fingerprint_of)


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
        lambda: loop.call_on_loop(atspi.probe_desktop, timeout=10.0)
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

    result = loop.call_on_loop(work, timeout=20.0)
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

    matches, observations, truncated = loop.call_on_loop(work, timeout=20.0)
    revision = _registry.record(observations)
    return {
        "elements": [m.to_json() for m in matches],
        "matchCount": len(matches),
        "searchTruncated": truncated,
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

    element = loop.call_on_loop(work, timeout=10.0)
    return {
        "element": element.to_json(),
        "revision": _registry.revision,
        "backend": atspi.BACKEND_NAME,
    }


def _method_get_revision(_params: dict[str, Any]) -> dict[str, Any]:
    return {"revision": _registry.revision}


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


def build_server(socket_path: str) -> JsonRpcServer:
    server = JsonRpcServer(socket_path)
    server.register("getDesktopCapabilities", _method_capabilities)
    server.register("listApplications", _method_list_applications)
    server.register("listWindows", _method_list_windows)
    server.register("inspectWindow", _method_inspect_window)
    server.register("queryElements", _method_query_elements)
    server.register("getElement", _method_get_element)
    server.register("getRevision", _method_get_revision)
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="desktop_service")
    parser.add_argument("--socket", default=None, help="Unix socket path to listen on")
    parser.add_argument("--session", default=None, help="Session name for the default socket path")
    args = parser.parse_args(argv)

    socket_path = args.socket or default_socket_path(args.session)

    _die_with_parent()
    loop.get_loop().start()
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
