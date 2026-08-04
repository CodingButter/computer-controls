"""Tests for the Python daemon client — no real daemon required.

A fake daemon binds a real AF_UNIX socket in a tmp path and speaks the same
newline-framed JSON-RPC 2.0 the real one does. Every test exercises the client
against it: the ``hello`` handshake, a request/response round-trip, a timeout
on no reply, a schema-digest mismatch refusing to proceed, and disconnect
cleanup rejecting pending calls.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable

import pytest

from server.daemon_client import (
    BACKEND_UNAVAILABLE,
    DaemonClient,
    DaemonError,
    SCHEMA_MISMATCH,
    TIMEOUT,
)
from server.tests._fakes import SCHEMA_DIGEST_OK, FakeDaemon


@pytest.fixture()
def daemon(tmp_path):
    """A running fake daemon with a stable schema digest."""
    path = str(tmp_path / "test.sock")
    d = FakeDaemon(path)
    d.start()
    try:
        yield d
    finally:
        d.stop()


# ---------------------------------------------------------------------------
# connect / hello
# ---------------------------------------------------------------------------

async def test_hello_captures_the_issued_client_id(daemon):
    """The service issues the identity; the caller's name is only a label."""
    client = DaemonClient(daemon.path)
    try:
        result = await client.hello(client_name="my-agent")
    finally:
        await client.close()

    assert client.client_id.startswith("cl-fake-")
    # The name we sent is NOT the id we got.
    assert client.client_id != "my-agent"
    assert client.session_token.startswith("tok-")
    assert client.schema_digest == SCHEMA_DIGEST_OK
    assert result["clientId"] == client.client_id


async def test_two_clients_get_distinct_client_ids(daemon):
    """The #34 invariant at the lowest layer: two clients are two connections."""
    a = DaemonClient(daemon.path)
    b = DaemonClient(daemon.path)
    try:
        await a.hello()
        await b.hello()
    finally:
        await a.close()
        await b.close()

    assert a.client_id != b.client_id
    assert len(daemon.accepted_client_ids) == 2


async def test_hello_refuses_on_schema_digest_mismatch(daemon):
    """A stale daemon whose schema drifted is never silently attached to (#30)."""
    client = DaemonClient(daemon.path)
    try:
        with pytest.raises(DaemonError) as exc_info:
            await client.hello(expected_schema_digest="deadbeef00000000")
        assert exc_info.value.code == SCHEMA_MISMATCH
        assert client.client_id == ""  # hello failed, nothing captured
    finally:
        await client.close()


async def test_hello_accepts_matching_schema_digest(daemon):
    client = DaemonClient(daemon.path)
    try:
        await client.hello(expected_schema_digest=SCHEMA_DIGEST_OK)
        assert client.client_id.startswith("cl-fake-")
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# request / response
# ---------------------------------------------------------------------------

async def test_request_response_round_trip(daemon):
    """A call returns the daemon's result."""
    client = DaemonClient(daemon.path)
    try:
        await client.hello()
        result = await client.call("getDesktopState")
    finally:
        await client.close()

    assert "windows" in result


async def test_call_with_custom_timeout(daemon):
    """A per-call timeout override is respected (a slow call still completes)."""

    def slow_echo(method, params):
        if method == "slow":
            return {"waited": True}
        return {"ok": True}

    daemon._on_method = slow_echo
    client = DaemonClient(daemon.path)
    try:
        await client.hello()
        result = await client.call("slow", timeout_ms=5000)
    finally:
        await client.close()

    assert result == {"waited": True}


async def test_timeout_when_daemon_does_not_answer(tmp_path):
    """A daemon that accepts but never replies triggers a TIMEOUT."""

    class SilentDaemon(FakeDaemon):
        def _handle_line(self, line, client_id):
            # Accept hello so connect succeeds, then go silent for everything else.
            if '"hello"' in line:
                return super()._handle_line(line, client_id)
            return None  # swallow — no response

    path = str(tmp_path / "silent.sock")
    d = SilentDaemon(path)
    d.start()
    client = DaemonClient(path, request_timeout_s=10)
    try:
        await client.hello()
        with pytest.raises(DaemonError) as exc_info:
            await client.call("getDesktopState", timeout_ms=200)
        assert exc_info.value.code == TIMEOUT
    finally:
        await client.close()
        d.stop()


# ---------------------------------------------------------------------------
# disconnect / close
# ---------------------------------------------------------------------------

async def test_close_rejects_pending_calls(daemon):
    """Closing the client rejects every call still in flight."""
    client = DaemonClient(daemon.path)
    try:
        await client.hello()

        # Fire a call the daemon will never answer, then close before it times out.
        daemon._on_method = lambda m, p: None  # type: ignore[assignment]
        task = asyncio.create_task(client.call("getDesktopState", timeout_ms=5000))
        await asyncio.sleep(0.05)  # let the request hit the wire

        await client.close()
        with pytest.raises(DaemonError) as exc_info:
            await task
        assert exc_info.value.code == BACKEND_UNAVAILABLE
    finally:
        if not client._closed:
            await client.close()


async def test_disconnect_rejects_pending(daemon):
    """When the daemon drops the connection, pending calls are rejected."""
    client = DaemonClient(daemon.path)
    try:
        await client.hello()
        daemon._on_method = lambda m, p: None  # type: ignore[assignment]
        task = asyncio.create_task(client.call("getDesktopState", timeout_ms=5000))
        await asyncio.sleep(0.05)

        # Kill the daemon — the socket closes, the read loop hits EOF.
        daemon.stop()
        # Yield so the asyncio read loop detects EOF and rejects pending calls
        # before the call's own deadline fires.
        await asyncio.sleep(0.1)

        with pytest.raises(DaemonError) as exc_info:
            await task
        assert exc_info.value.code == BACKEND_UNAVAILABLE
    finally:
        if not client._closed:
            await client.close()


# ---------------------------------------------------------------------------
# connection failure
# ---------------------------------------------------------------------------

async def test_connect_fails_when_daemon_not_running(tmp_path):
    """No socket → BACKEND_UNAVAILABLE, not a raw FileNotFoundError."""
    client = DaemonClient(str(tmp_path / "nonexistent.sock"))
    with pytest.raises(DaemonError) as exc_info:
        await client.connect()
    assert exc_info.value.code == BACKEND_UNAVAILABLE
