"""The first Python client of the desktop service daemon.

One instance owns one unix-socket connection — the #34 invariant at the lowest
layer: whatever opens this socket on an agent's behalf opens one connection per
agent, never one for the whole server. Identity, grants, element ownership and
disconnect cleanup all key off that connection (see ``transport.py``), so
sharing it across agents would collapse them into one client in all four places
at once.

The daemon speaks newline-framed JSON-RPC 2.0 over a local ``0600`` unix socket.
This client mirrors the semantics of the TypeScript reference client
(``plugin/src/client.ts``): an id→pending correlation table allows several
calls to be in flight against one connection, each with its own deadline, and a
close rejects every pending call at once.

The ``hello`` handshake captures the identity the *service* issued (never one
the caller claimed) and the ``schemaDigest`` — the #30 guard against silently
attaching to a stale daemon whose method table no longer matches the schema the
client was built against.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

# --- error codes (mirror plugin/src/client.ts) ------------------------------

BACKEND_UNAVAILABLE = "BACKEND_UNAVAILABLE"
TIMEOUT = "TIMEOUT"
SCHEMA_MISMATCH = "SCHEMA_MISMATCH"
INCOMPATIBLE = "INCOMPATIBLE"

DEFAULT_REQUEST_TIMEOUT_S = 20.0
DEFAULT_CONNECT_TIMEOUT_S = 5.0

#: The protocol version this client speaks. A major mismatch fails the
#: ``hello`` call server-side; a minor one is reported but allowed.
PROTOCOL_VERSION = "1.0"


class DaemonError(Exception):
    """An error from the daemon client, carrying a stable code.

    The code matches the TypeScript client's error codes so that a caller
    switching between the two sees the same vocabulary.
    """

    def __init__(
        self, code: str, message: str, detail: dict[str, Any] | None = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.detail = detail or {}


class DaemonClient:
    """One connection to the daemon.

    Create one per agent. Do not share across agents — see the #34 invariant.
    """

    def __init__(
        self,
        socket_path: str,
        *,
        request_timeout_s: float = DEFAULT_REQUEST_TIMEOUT_S,
        connect_timeout_s: float = DEFAULT_CONNECT_TIMEOUT_S,
    ) -> None:
        self.socket_path = socket_path
        self._request_timeout_s = request_timeout_s
        self._connect_timeout_s = connect_timeout_s

        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._read_task: asyncio.Task[None] | None = None

        self._next_id = 1
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._closed = False

        # Populated by ``hello``:
        self.client_id: str = ""
        self.session_token: str = ""
        self.schema_digest: str = ""
        self.protocol_version: str = ""
        self.compatible: bool = True
        self.version_difference: str = "none"
        self.observation_mode: str = "active"

    @property
    def connected(self) -> bool:
        return (
            self._writer is not None
            and not self._writer.is_closing()
            and not self._closed
        )

    async def connect(self) -> None:
        """Open the unix socket. Raises ``BACKEND_UNAVAILABLE`` on failure."""
        if self.connected:
            return
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_unix_connection(self.socket_path),
                timeout=self._connect_timeout_s,
            )
        except (FileNotFoundError, ConnectionRefusedError) as exc:
            raise DaemonError(
                BACKEND_UNAVAILABLE,
                f"The desktop service is not running "
                f"(no socket at {self.socket_path})",
                {"socketPath": self.socket_path},
            ) from exc
        except asyncio.TimeoutError as exc:
            raise DaemonError(
                BACKEND_UNAVAILABLE,
                f"Timed out connecting to the desktop service "
                f"at {self.socket_path}",
                {"socketPath": self.socket_path},
            ) from exc

        self._closed = False
        self._read_task = asyncio.create_task(
            self._read_loop(), name="daemon-client-read"
        )

    async def hello(
        self,
        *,
        protocol_version: str = PROTOCOL_VERSION,
        client_name: str | None = None,
        expected_schema_digest: str | None = None,
    ) -> dict[str, Any]:
        """Perform the version handshake and capture the issued identity.

        The service issues a ``clientId`` of its own choosing — the caller's
        ``client_name`` is only a label. If ``expected_schema_digest`` is given
        and the service reports a different one, the client refuses to proceed:
        attaching to a stale daemon whose method table has drifted silently
        breaks method dispatch (#30).

        Returns the full ``hello`` result dict.
        """
        params: dict[str, Any] = {"protocolVersion": protocol_version}
        if client_name is not None:
            params["clientName"] = client_name

        result = await self.call("hello", params)

        # Validate before committing any captured state — a failed hello leaves
        # the client as if it never happened.
        compatible = result.get("compatible", True)
        reported_digest = result.get("schemaDigest", "")

        if not compatible:
            raise DaemonError(
                INCOMPATIBLE,
                "The daemon reported an incompatible protocol version "
                f"({result.get('protocolVersion', protocol_version)})",
                {"protocolVersion": result.get("protocolVersion", protocol_version)},
            )

        if (
            expected_schema_digest is not None
            and reported_digest
            and reported_digest != expected_schema_digest
        ):
            raise DaemonError(
                SCHEMA_MISMATCH,
                "The daemon's schema digest does not match the expected value — "
                "the daemon may be stale (#30).",
                {"expected": expected_schema_digest, "actual": reported_digest},
            )

        self.client_id = result.get("clientId", "")
        self.session_token = result.get("sessionToken", "")
        self.schema_digest = reported_digest
        self.protocol_version = result.get("protocolVersion", protocol_version)
        self.compatible = compatible
        self.version_difference = result.get("versionDifference", "none")
        self.observation_mode = result.get("observationMode", "active")

        return result

    async def call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout_ms: float | None = None,
    ) -> Any:
        """Send a JSON-RPC request and await the result.

        ``timeout_ms`` overrides the default request deadline for this one call
        — a method that deliberately takes time (typing a sentence at human
        speed) knows how long it will take before it starts.
        """
        await self.connect()
        writer = self._writer
        if writer is None or not self.connected:
            raise DaemonError(
                BACKEND_UNAVAILABLE,
                "The desktop service is not connected",
                {"socketPath": self.socket_path},
            )

        request_id = self._next_id
        self._next_id += 1
        deadline = (timeout_ms / 1000) if timeout_ms else self._request_timeout_s

        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self._pending[request_id] = future

        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params or {},
        }
        line = (json.dumps(request) + "\n").encode("utf-8")

        try:
            writer.write(line)
            await writer.drain()
            return await asyncio.wait_for(future, timeout=deadline)
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            raise DaemonError(
                TIMEOUT,
                f"The desktop service did not answer {method} "
                f"within {deadline * 1000:.0f}ms",
                {"method": method, "timeoutMs": deadline * 1000},
            ) from None
        except DaemonError:
            raise
        except Exception as exc:
            self._pending.pop(request_id, None)
            raise DaemonError(
                BACKEND_UNAVAILABLE,
                f"Lost the connection to the desktop service: {exc}",
                {"socketPath": self.socket_path},
            ) from exc

    async def close(self) -> None:
        """Close the connection and reject every pending call."""
        self._closed = True
        if self._read_task is not None:
            self._read_task.cancel()
            try:
                await self._read_task
            except (asyncio.CancelledError, Exception):
                pass
            self._read_task = None

        writer = self._writer
        self._writer = None
        self._reader = None

        if writer is not None:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

        self._reject_all(
            BACKEND_UNAVAILABLE, "The client was closed", {}
        )

    # --- internals -----------------------------------------------------------

    async def _read_loop(self) -> None:
        """Read newline-delimited responses and dispatch to pending futures."""
        reader = self._reader
        if reader is None:
            return
        try:
            while True:
                raw = await reader.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                self._on_line(line)
        except (asyncio.CancelledError, Exception):
            pass
        # EOF or error — the connection is gone.
        self._on_disconnect()

    def _on_line(self, line: str) -> None:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            return
        if not isinstance(message, dict):
            return
        msg_id = message.get("id")
        if not isinstance(msg_id, int):
            return
        future = self._pending.pop(msg_id, None)
        if future is None or future.done():
            return
        if "error" in message and message["error"] is not None:
            err = message["error"]
            code = (err.get("data") or {}).get("code", "INTERNAL_ERROR")
            future.set_exception(
                DaemonError(
                    code,
                    err.get("message", "The desktop service returned an error"),
                    (err.get("data") or {}).get("detail", {}),
                )
            )
        else:
            future.set_result(message.get("result"))

    def _on_disconnect(self) -> None:
        self._closed = True
        self._writer = None
        self._reject_all(
            BACKEND_UNAVAILABLE,
            "The desktop service closed the connection",
            {"socketPath": self.socket_path},
        )

    def _reject_all(self, code: str, message: str, detail: dict[str, Any]) -> None:
        error = DaemonError(code, message, detail)
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(error)
        self._pending.clear()
