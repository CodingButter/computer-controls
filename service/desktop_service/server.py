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

from . import capabilities
from .backends import atspi, loop
from .errors import InvalidParams
from .transport import JsonRpcServer, default_socket_path


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
