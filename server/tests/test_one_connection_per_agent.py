"""The #34 invariant test: one daemon connection per agent session.

Mirrors ``test_connections.py``'s two-simultaneous-connections pattern at the
server layer. Two concurrent Sessions must result in TWO distinct accepted
daemon connections with TWO distinct issued clientIds. The server never pools
or shares a daemon connection across agents — identity, grants, element
ownership, and disconnect cleanup all key off the connection.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from server.session import Session
from server.tests._fakes import FakeDaemon


class _NullCollector:
    async def __call__(self, msg: dict[str, Any]) -> None:
        pass


@pytest.fixture
def daemon(tmp_path):
    path = str(tmp_path / "invariant.sock")
    d = FakeDaemon(path)
    d.start()
    try:
        yield d
    finally:
        d.stop()


async def test_two_sessions_get_distinct_connections(daemon):
    """Two simultaneous sessions = two accepted connections, two clientIds."""
    a = Session(daemon.path, _NullCollector(), poll_interval_s=10)
    b = Session(daemon.path, _NullCollector(), poll_interval_s=10)
    try:
        await a.start()
        await b.start()

        # Two distinct connections were accepted.
        assert len(daemon.accepted_client_ids) == 2

        # Two distinct issued identities.
        assert a.client_id != b.client_id
        assert a.client_id in daemon.accepted_client_ids
        assert b.client_id in daemon.accepted_client_ids
    finally:
        await a.stop()
        await b.stop()


async def test_connection_is_not_shared_or_pooled(daemon):
    """Opening, closing, and opening again creates a NEW connection each time.

    A server that pooled connections would reuse the same clientId for the
    second session — the invariant forbids that.
    """
    collector = _NullCollector()

    # First session.
    first = Session(daemon.path, collector, poll_interval_s=10)
    await first.start()
    first_id = first.client_id
    await first.stop()

    # Second session after the first is gone.
    second = Session(daemon.path, collector, poll_interval_s=10)
    await second.start()
    second_id = second.client_id
    await second.stop()

    assert first_id != second_id
    assert len(daemon.accepted_client_ids) == 2


async def test_each_session_owns_exactly_one_connection(daemon):
    """One session opens exactly one daemon connection, not more."""
    collector = _NullCollector()
    session = Session(daemon.path, collector, poll_interval_s=10)
    try:
        await session.start()
        # Let the poll loop run a few iterations.
        await asyncio.sleep(0.2)
        # Still only one accepted connection for this session.
        assert len(daemon.accepted_client_ids) == 1
        assert daemon.accepted_client_ids[0] == session.client_id
    finally:
        await session.stop()
