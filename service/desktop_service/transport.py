"""Newline-framed JSON-RPC 2.0 over a Unix socket.

One request per line, one response per line. The framing is deliberately boring:
a desktop service is not a throughput problem, and a format a human can read with
`nc` is worth more here than a binary one.

Threading: this server accepts on its own thread and serves each connection on a
thread of its own. It never touches a toolkit binding directly — handlers marshal
onto the GLib loop themselves (see `backends/loop.py`). That is what lets several
clients be in flight at once without any of them reaching the desktop off-thread.

One connection per agent
------------------------

This socket is local, `0600`, and stays that way. What reaches it may not be
local for much longer: the shape this project is heading for is one server per
machine — this daemon, an agent layer above it, a gateway above that — and many
clients holding nothing but a server URL and a credential. Nothing
network-facing ever speaks to the desktop directly, which is the entire reason
the guarantees below this line keep their meaning. The full ruling on how a
client reaches that server — the tiers, the constraints, what the daemon is not
— is in `docs/06-how-a-stranger-connects.md`.

So the rule for whatever opens this socket on their behalf: **one connection per
agent, never one for the server.** The connection is not a transport detail
here, it is the unit of identity, and four separate mechanisms key off it:

- the identity minted in `_serve_connection` below, which the client cannot
  influence because it is issued before the client has said anything;
- the grant, filed under that identity by `security.Consent` and consulted under
  it too;
- ownership of an element while it is being written, keyed by the same identity
  in `holds`;
- the teardown at the end of this file, which releases the holds *of that
  connection* when it drops.

Multiplex two agents onto one connection and they become one client in all four
places at once: indistinguishable in the audit log, each inheriting whatever
grant the other was given, each able to release a hold the other is mid-write
under, and both torn down when either one goes away. That is not a degraded
version of the guarantee, it is the hole the issued identity was introduced to
close, reopened one level up.

The cost of obeying the rule is a thread and a socket. Connections are cheap,
each one already gets its own thread, and `tests/test_connections.py` holds two
of them open at once and proves the four mechanisms stay apart.
"""

from __future__ import annotations

import json
import os
import socket
import stat
import threading
from typing import Any, Callable

from . import holds, identity, send_gate
from .protocol_generated import SCHEMA_DIGEST
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

    The name carries the schema digest so that a client and a daemon built from
    the same protocol agree on one socket, while a client whose protocol differs
    finds no socket at all and starts its own. The filesystem does the matching:
    no version negotiation, no compatibility check — two builds that cannot
    understand each other never meet on the same socket.

    Within one build, one name is still what makes several clients agree about
    one desktop: two services on one desktop would each hold their own element
    registry and revision counter, and an element id from one would be
    meaningless to the other. Digest keying preserves that while keeping
    different builds apart.
    """
    return default_socket_path(f"{DAEMON_SESSION}-{SCHEMA_DIGEST}")


def _nothing_is_listening(path: str) -> bool:
    """Whether a socket file is a leftover rather than a live service.

    Presence proves nothing — a crashed process leaves its socket file behind
    looking exactly like a working one. The connection attempt is the test.
    """
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.5)
    try:
        probe.connect(path)
    except (ConnectionRefusedError, FileNotFoundError, socket.timeout, OSError):
        return True
    finally:
        probe.close()
    return False


def sweep_dead_daemon_sockets(keep: str) -> list[str]:
    """Remove daemon socket files left behind by daemons that are gone.

    Digest keying costs the one self-healing property the single fixed name
    had: a crashed daemon's file used to be reclaimed by the next one, because
    the next one wanted the same name. Now every schema change mints a new
    name, so a daemon killed rather than stopped leaves a file nobody will ever
    ask for again, and the runtime directory grows by one for every build that
    ever died badly.

    Sweeping on startup is the cheapest place to do it: a daemon coming up is
    already the newest thing here, and a file it can connect to belongs to a
    daemon still serving somebody — those are left alone.
    """
    removed: list[str] = []
    directory = socket_directory()
    for name in sorted(os.listdir(directory)):
        if not name.startswith(f"{DAEMON_SESSION}-") or not name.endswith(".sock"):
            continue
        path = os.path.join(directory, name)
        if os.path.abspath(path) == os.path.abspath(keep):
            continue
        try:
            if not stat.S_ISSOCK(os.stat(path).st_mode):
                continue
            if _nothing_is_listening(path):
                os.unlink(path)
                removed.append(path)
        except FileNotFoundError:
            continue
    return removed


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

    @property
    def connection_count(self) -> int:
        with self._lock:
            return len(self._connections)

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
            send_gate.release_client(client_id)
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
