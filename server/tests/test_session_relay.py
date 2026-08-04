"""Tests for the desktop-state relay Session.

A fake daemon feeds canned desktop state and deltas; the test asserts the
Session's WebSocket sink receives the initial picture, then subsequent deltas,
and that an incomplete delta (``complete: false``) triggers a ``getDesktopState``
re-acquire.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from server.session import Session
from server.tests._fakes import FakeDaemon


# ---------------------------------------------------------------------------
# Canned desktop-state sequences
# ---------------------------------------------------------------------------

def _make_handler():
    """Build a stateful handler that returns canned responses in sequence."""
    calls: list[tuple[str, dict[str, Any]]] = []

    desktop_states = [
        {"windows": [{"windowId": "w1", "title": "Terminal"}], "activeWindowId": "w1"},
        {"windows": [{"windowId": "w2", "title": "Browser"}], "activeWindowId": "w2"},
    ]
    state_idx = [0]
    delta_seq = [3]  # revision counter for getDeltaSince

    def handler(method: str, params: dict[str, Any]) -> Any:
        calls.append((method, params))
        if method == "getDesktopState":
            idx = min(state_idx[0], len(desktop_states) - 1)
            return desktop_states[idx]
        if method == "getDeltaSince":
            since = params.get("sinceRevision", 0)
            if since == 0:
                # Initial cursor establishment.
                return {"changes": [], "revision": 1, "complete": True}
            if since == 1:
                # First real delta — a window focus change.
                return {
                    "changes": [{"type": "focus", "windowId": "w2"}],
                    "revision": 2,
                    "complete": True,
                }
            if since == 2:
                # Incomplete delta — forces re-acquire.
                return {
                    "changes": [],
                    "revision": 4,
                    "complete": False,
                    "resumeRevision": 4,
                }
            # After re-acquire from revision 4 — idle.
            return {"changes": [], "revision": 4, "complete": True}
        return {"ok": True}

    handler.calls = calls  # type: ignore[attr-defined]
    handler.state_idx = state_idx  # type: ignore[attr-defined]
    return handler


class _MessageCollector:
    """Async sink that collects every message sent by the Session."""

    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self._event = asyncio.Event()

    async def __call__(self, msg: dict[str, Any]) -> None:
        self.messages.append(msg)
        self._event.set()

    async def wait_for(self, count: int, timeout: float = 5.0) -> None:
        """Wait until at least ``count`` messages have arrived."""
        async def _check() -> None:
            while len(self.messages) < count:
                self._event.clear()
                await asyncio.wait_for(self._event.wait(), timeout=timeout)
        await asyncio.wait_for(_check(), timeout=timeout)


@pytest.fixture
def daemon(tmp_path):
    handler = _make_handler()
    path = str(tmp_path / "relay.sock")
    d = FakeDaemon(path, on_method=handler)
    d.start()
    d._test_handler = handler  # type: ignore[attr-defined]
    try:
        yield d
    finally:
        d.stop()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

async def test_relay_sends_initial_picture(daemon):
    """The first WS message is the desktop_state from getDesktopState."""
    collector = _MessageCollector()
    session = Session(daemon.path, collector, poll_interval_s=0.05)
    try:
        await session.start()
        await collector.wait_for(1)
    finally:
        await session.stop()

    assert collector.messages[0]["type"] == "desktop_state"
    assert collector.messages[0]["activeWindowId"] == "w1"


async def test_relay_sends_deltas(daemon):
    """After the initial picture, subsequent changes arrive as deltas."""
    collector = _MessageCollector()
    session = Session(daemon.path, collector, poll_interval_s=0.05)
    try:
        await session.start()
        await collector.wait_for(2)
    finally:
        await session.stop()

    assert collector.messages[0]["type"] == "desktop_state"
    assert collector.messages[1]["type"] == "delta"
    assert collector.messages[1]["changes"][0]["windowId"] == "w2"


async def test_incomplete_delta_triggers_reacquire(daemon):
    """When the daemon reports complete:false, the relay re-acquires."""
    collector = _MessageCollector()
    session = Session(daemon.path, collector, poll_interval_s=0.05)
    try:
        await session.start()
        # initial picture(0) + initial cursor(no msg) + delta(1) + reacquire(2)
        await collector.wait_for(3)
    finally:
        await session.stop()

    types = [m["type"] for m in collector.messages]
    # The third message should be a desktop_state (re-acquired picture).
    assert "desktop_state" in types
    # At least two desktop_state messages: initial + re-acquired.
    assert types.count("desktop_state") >= 2


async def test_stop_closes_daemon_connection(daemon):
    """Stopping the session closes its daemon connection."""
    collector = _MessageCollector()
    session = Session(daemon.path, collector, poll_interval_s=0.05)
    await session.start()
    await collector.wait_for(1)
    assert session.connected

    await session.stop()
    assert not session.connected


async def test_session_gets_distinct_client_id(daemon):
    """The session's daemon client gets its own service-issued clientId."""
    collector = _MessageCollector()
    session = Session(daemon.path, collector, poll_interval_s=0.05)
    try:
        await session.start()
        await collector.wait_for(1)
        assert session.client_id.startswith("cl-fake-")
    finally:
        await session.stop()
