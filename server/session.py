"""Desktop-state relay: one Session owns one DaemonClient per agent.

The #34 invariant lives here: each authenticated WebSocket session gets its
own ``DaemonClient`` (Phase 1) — its own unix-socket connection to the daemon.
The server never pools or shares a connection across agents, because identity,
grants, element ownership, and disconnect cleanup all key off the connection.

The relay polls the daemon for desktop state (``getDesktopState`` for the
initial picture, then ``getDeltaSince`` cursor-forward for incremental
changes) and pushes a normalized message stream to the WebSocket.  When the
daemon reports an incomplete delta (``complete: false``), the relay
re-acquires the full picture via ``getDesktopState`` and resumes from the
``resumeRevision`` cursor.

This bridges #40 (subscribe) pragmatically — the daemon already answers these
queries; the server polls and relays.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from .daemon_client import DaemonClient, DaemonError

log = logging.getLogger(__name__)

#: How often the poll loop calls ``getDeltaSince``.  Short enough to feel live,
#: long enough to not hammer the daemon.
DEFAULT_POLL_INTERVAL_S = 0.5

SendFn = Callable[[dict[str, Any]], Awaitable[None]]


class Session:
    """One agent session — one daemon connection, one relay to the client."""

    def __init__(
        self,
        socket_path: str,
        send: SendFn,
        *,
        poll_interval_s: float = DEFAULT_POLL_INTERVAL_S,
        expected_schema_digest: str | None = None,
    ) -> None:
        self._client = DaemonClient(socket_path)
        self._send = send
        self._poll_interval = poll_interval_s
        self._expected_schema_digest = expected_schema_digest
        self._last_revision: int | None = None
        self._task: asyncio.Task[None] | None = None

    @property
    def client_id(self) -> str:
        return self._client.client_id

    @property
    def connected(self) -> bool:
        return self._client.connected

    async def start(self) -> None:
        """Open the daemon connection and start the poll loop."""
        await self._client.hello(
            client_name="server-layer-relay",
            expected_schema_digest=self._expected_schema_digest,
        )
        self._task = asyncio.create_task(
            self._poll_loop(), name="session-poll"
        )

    async def stop(self) -> None:
        """Cancel the poll loop and close the daemon connection."""
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        await self._client.close()

    # --- poll loop -----------------------------------------------------------

    async def _poll_loop(self) -> None:
        """Relay desktop state from the daemon to the client WebSocket."""
        try:
            # Initial picture.
            state = await self._client.call("getDesktopState")
            await self._send({"type": "desktop_state", **state})

            # Establish the revision cursor.  Calling getDeltaSince(0) once
            # gives us the current revision without replaying changes we
            # already have from the initial picture.
            delta = await self._client.call(
                "getDeltaSince", {"sinceRevision": 0}
            )
            if delta.get("complete", True):
                self._last_revision = delta.get("revision", 0)
            else:
                # Fell behind even on the first call — re-acquire.
                state = await self._client.call("getDesktopState")
                await self._send({"type": "desktop_state", **state})
                self._last_revision = delta.get(
                    "resumeRevision", delta.get("revision", 0)
                )

            # Cursor-forward deltas.
            while True:
                await asyncio.sleep(self._poll_interval)
                await self._poll_once()
        except DaemonError as exc:
            log.warning("session %s: daemon error: %s", self.client_id, exc)
            await self._send(
                {"type": "error", "code": exc.code, "message": str(exc)}
            )
        except asyncio.CancelledError:
            raise

    async def _poll_once(self) -> None:
        """Fetch one delta and relay it, re-acquiring on incomplete."""
        assert self._last_revision is not None
        delta = await self._client.call(
            "getDeltaSince", {"sinceRevision": self._last_revision}
        )

        if delta.get("complete", True):
            changes = delta.get("changes", [])
            if changes:
                await self._send(
                    {
                        "type": "delta",
                        "changes": changes,
                        "revision": delta.get("revision", 0),
                    }
                )
            self._last_revision = delta.get("revision", self._last_revision)
        else:
            # The daemon dropped history we needed — re-acquire the full
            # picture and resume from the safe cursor.
            state = await self._client.call("getDesktopState")
            await self._send({"type": "desktop_state", **state})
            self._last_revision = delta.get(
                "resumeRevision", delta.get("revision", self._last_revision)
            )
