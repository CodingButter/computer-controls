"""Newline-framed JSON-RPC 2.0 over a Unix socket.

One request per line, one response per line. The framing is deliberately boring:
a desktop service is not a throughput problem, and a format a human can read with
`nc` is worth more here than a binary one.

Threading: this server accepts on its own thread and serves each connection on a
thread of its own. It never touches a toolkit binding directly — handlers marshal
onto the GLib loop themselves (see `backends/loop.py`). That is what lets several
clients be in flight at once without any of them reaching the desktop off-thread.
"""

from __future__ import annotations

import json
import os
import socket
import stat
import threading
from typing import Any, Callable

from . import holds, identity
from .errors import (
    JSONRPC_INVALID_REQUEST,
    JSONRPC_PARSE_ERROR,
    DesktopError,
    ErrorCode,
    MethodNotFound,
)

Handler = Callable[[dict[str, Any]], Any]

SOCKET_MODE = 0o600


DAEMON_SESSION = "daemon"


def socket_directory() -> str:
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    directory = os.path.join(runtime_dir, "mastracode-desktop")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    return directory


def default_socket_path(session: str | None = None) -> str:
    name = session or str(os.getpid())
    return os.path.join(socket_directory(), f"{name}.sock")


def daemon_socket_path() -> str:
    """
    Where a shared desktop service listens.

    One name, known to every client without being told: a client that finds a
    live service here attaches to it instead of starting a second one. That is
    the difference between a desktop each client sees a private view of and one
    desktop several clients agree about — two services on one desktop would
    each hold their own element registry and their own revision counter, and an
    element id from one would be meaningless to the other.
    """
    return default_socket_path(DAEMON_SESSION)


class JsonRpcServer:
    def __init__(
        self, socket_path: str, on_disconnect: Callable[[str], None] | None = None
    ) -> None:
        self.socket_path = socket_path
        # Told when a connection ends, because per-connection state has to be
        # able to end with it. The transport does not know what that state is —
        # it knows when the identity it minted stops meaning anything.
        self._on_disconnect = on_disconnect
        self._handlers: dict[str, Handler] = {}
        self._server: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._connections: set[socket.socket] = set()
        self._lock = threading.Lock()
        self._stopping = threading.Event()

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler

    @property
    def methods(self) -> list[str]:
        return sorted(self._handlers)

    def _reclaim_socket_path(self) -> None:
        """Replace a stale socket file rather than inheriting it.

        A crashed run leaves the socket file behind. Binding fails on it, and
        deleting one that a live server still owns would silently steal traffic —
        so probe it first and only remove it when nothing answers.
        """
        if not os.path.exists(self.socket_path):
            return
        if not stat.S_ISSOCK(os.stat(self.socket_path).st_mode):
            raise DesktopError(
                ErrorCode.INTERNAL_ERROR,
                f"{self.socket_path} exists and is not a socket",
                {"path": self.socket_path},
            )
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        probe.settimeout(0.5)
        try:
            probe.connect(self.socket_path)
        except (ConnectionRefusedError, FileNotFoundError, socket.timeout, OSError):
            os.unlink(self.socket_path)
            return
        finally:
            probe.close()
        raise DesktopError(
            ErrorCode.INTERNAL_ERROR,
            f"another desktop service is already listening on {self.socket_path}",
            {"path": self.socket_path},
        )

    def start(self) -> None:
        self._reclaim_socket_path()
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(self.socket_path)
        os.chmod(self.socket_path, SOCKET_MODE)
        server.listen(16)
        server.settimeout(0.5)
        self._server = server
        self._thread = threading.Thread(
            target=self._accept_loop, name="desktop-rpc-accept", daemon=True
        )
        self._thread.start()

    def _accept_loop(self) -> None:
        server = self._server
        assert server is not None
        while not self._stopping.is_set():
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with self._lock:
                self._connections.add(conn)
            threading.Thread(
                target=self._serve_connection,
                args=(conn,),
                name="desktop-rpc-conn",
                daemon=True,
            ).start()

    def _serve_connection(self, conn: socket.socket) -> None:
        # One identity per connection, minted here and held for as long as the
        # connection lasts. This is the only place it can be assigned honestly:
        # by the time a request is parsed, everything in it came from the client.
        client_id = identity.mint()
        try:
            with identity.bound(client_id), conn.makefile("rwb") as stream:
                for raw in stream:
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    response = self.handle_line(line)
                    if response is None:
                        continue
                    stream.write((json.dumps(response) + "\n").encode("utf-8"))
                    stream.flush()
        except OSError:
            pass
        finally:
            # A client that disconnects halfway through a write is not coming
            # back to release anything, and an element owned by a process that
            # no longer exists is owned for the rest of the session.
            holds.release_all(client_id)
            with self._lock:
                self._connections.discard(conn)
            try:
                conn.close()
            except OSError:
                pass
            if self._on_disconnect is not None:
                try:
                    self._on_disconnect(client_id)
                except Exception:  # pragma: no cover - cleanup must not raise
                    pass

    def handle_line(self, line: str) -> dict[str, Any] | None:
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            return _error_response(
                None, JSONRPC_PARSE_ERROR, f"Invalid JSON: {exc}", ErrorCode.INVALID_PARAMS
            )
        if not isinstance(request, dict):
            return _error_response(
                None,
                JSONRPC_INVALID_REQUEST,
                "A JSON-RPC request must be an object",
                ErrorCode.INVALID_PARAMS,
            )

        request_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        if not isinstance(method, str):
            return _error_response(
                request_id,
                JSONRPC_INVALID_REQUEST,
                "Request is missing a string 'method'",
                ErrorCode.INVALID_PARAMS,
            )
        if not isinstance(params, dict):
            return _error_response(
                request_id,
                JSONRPC_INVALID_REQUEST,
                "'params' must be an object",
                ErrorCode.INVALID_PARAMS,
            )

        handler = self._handlers.get(method)
        try:
            if handler is None:
                raise MethodNotFound(method)
            result = handler(params)
        except DesktopError as exc:
            if request_id is None:
                return None
            return {"jsonrpc": "2.0", "id": request_id, "error": exc.to_jsonrpc_error()}
        except Exception as exc:  # noqa: BLE001 - a handler bug must not kill the server
            if request_id is None:
                return None
            wrapped = DesktopError(
                ErrorCode.INTERNAL_ERROR,
                f"{type(exc).__name__}: {exc}",
                {"method": method},
            )
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": wrapped.to_jsonrpc_error(),
            }

        if request_id is None:
            return None
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    def stop(self) -> None:
        self._stopping.set()
        if self._server is not None:
            try:
                self._server.close()
            except OSError:
                pass
        if self._thread is not None:
            self._thread.join(2.0)
        with self._lock:
            connections = list(self._connections)
            self._connections.clear()
        for conn in connections:
            try:
                conn.close()
            except OSError:
                pass
        try:
            os.unlink(self.socket_path)
        except FileNotFoundError:
            pass


def _error_response(
    request_id: Any, jsonrpc_code: int, message: str, code: str
) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {
            "code": jsonrpc_code,
            "message": message,
            "data": {"code": code, "detail": {}},
        },
    }
