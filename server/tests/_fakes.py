"""Shared test fakes for server-layer tests (not a test module itself).

``FakeDaemon`` is extracted here so every test file can exercise the relay and
invariant tests against the same minimal daemon that speaks the real
newline-framed JSON-RPC 2.0 protocol over a bound AF_UNIX socket.
"""

from __future__ import annotations

import json
import socket
import threading
from typing import Any, Callable

SCHEMA_DIGEST_OK = "bfa45250563894d0"


class FakeDaemon:
    """A minimal daemon that accepts connections and answers JSON-RPC calls.

    Each accepted connection gets a unique ``cl-`` id (minted at accept, before
    reading anything the client sent) — the same rule the real transport enforces.
    """

    def __init__(
        self,
        path: str,
        *,
        schema_digest: str = SCHEMA_DIGEST_OK,
        on_method: Callable[[str, dict[str, Any]], Any] | None = None,
    ) -> None:
        self.path = path
        self._schema_digest = schema_digest
        self._on_method = on_method or self._default_handler
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(path)
        self._server.listen(16)
        self._server.settimeout(0.5)
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._counter = 0
        self._lock = threading.Lock()
        #: Every accepted connection, in order. Each is the issued ``cl-`` id.
        self.accepted_client_ids: list[str] = []
        #: Live connection sockets, tracked so stop() can close them.
        self._conns: list[socket.socket] = []

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._accept_loop, name="fake-daemon", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        # Close accepted connections so their clients see EOF.
        with self._lock:
            for conn in self._conns:
                try:
                    conn.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                try:
                    conn.close()
                except OSError:
                    pass
            self._conns.clear()
        if self._thread is not None:
            self._thread.join(timeout=2)
        self._server.close()

    def _next_id(self) -> str:
        with self._lock:
            self._counter += 1
            return f"cl-fake-{self._counter}"

    def _accept_loop(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self._server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            client_id = self._next_id()
            self.accepted_client_ids.append(client_id)
            with self._lock:
                self._conns.append(conn)
            threading.Thread(
                target=self._serve,
                args=(conn, client_id),
                name="fake-daemon-conn",
                daemon=True,
            ).start()

    def _serve(self, conn: socket.socket, client_id: str) -> None:
        try:
            with conn.makefile("rwb") as stream:
                for raw in stream:
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    response = self._handle_line(line, client_id)
                    if response is None:
                        continue
                    stream.write((json.dumps(response) + "\n").encode())
                    stream.flush()
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _handle_line(self, line: str, client_id: str) -> dict[str, Any] | None:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            return {"jsonrpc": "2.0", "id": None, "error": {"message": "parse error"}}

        method = request.get("method", "")
        params = request.get("params") or {}
        req_id = request.get("id")

        if method == "hello":
            result = {
                "protocolVersion": "1.0",
                "compatible": True,
                "versionDifference": "none",
                "sessionToken": f"tok-{client_id}",
                "clientId": client_id,
                "schemaDigest": self._schema_digest,
                "observationMode": "active",
            }
            return {"jsonrpc": "2.0", "id": req_id, "result": result}

        try:
            result = self._on_method(method, params)
        except Exception as exc:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "message": str(exc),
                    "data": {"code": "INTERNAL_ERROR", "detail": {}},
                },
            }
        # A handler returning None means "no response" — the call hangs.
        if result is None:
            return None
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    @staticmethod
    def _default_handler(method: str, params: dict[str, Any]) -> Any:
        if method == "getDesktopState":
            return {"windows": [], "activeWindowId": ""}
        if method == "getDeltaSince":
            return {"changes": [], "revision": 1, "complete": True}
        return {"ok": True}
