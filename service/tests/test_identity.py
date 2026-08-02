"""Identity is issued by the service, and a caller cannot talk its way out of it.

These tests go through a real socket rather than calling the handlers directly,
because the whole claim is about what a connection knows that a request body
cannot change. A test that drove the handlers in-process would be testing the
fallback and reporting it as the rule.
"""

from __future__ import annotations

import json
import socket
import threading

import pytest

from desktop_service import identity
from desktop_service.transport import JsonRpcServer


@pytest.fixture()
def socket_path(tmp_path):
    return str(tmp_path / "identity.sock")


@pytest.fixture()
def served(socket_path):
    """A server whose one method reports whichever identity the service resolved."""
    seen: list[str] = []

    def whoami(params):
        # Exactly what the real guard does: issued identity first, caller's
        # claim only when there is no connection to identify.
        resolved = identity.current() or str(params.get("clientId") or "")
        seen.append(resolved)
        return {"clientId": resolved, "label": identity.current_label()}

    server = JsonRpcServer(socket_path)
    server.register("whoami", whoami)
    server.start()
    yield server, seen
    server.stop()


def _call(path: str, method: str, params: dict) -> dict:
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.connect(path)
    try:
        with conn.makefile("rwb") as stream:
            stream.write(
                (json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}) + "\n").encode()
            )
            stream.flush()
            return json.loads(stream.readline().decode())
    finally:
        conn.close()


def test_a_connection_is_given_an_identity_it_did_not_ask_for(served, socket_path):
    _server, _seen = served
    response = _call(socket_path, "whoami", {})
    assert response["result"]["clientId"].startswith("cl-")


def test_a_claimed_name_does_not_become_an_identity(served, socket_path):
    """The point of the whole exercise: agent two cannot be agent one."""
    _server, _seen = served
    response = _call(socket_path, "whoami", {"clientId": "some-other-agent"})
    resolved = response["result"]["clientId"]
    assert resolved != "some-other-agent"
    assert resolved.startswith("cl-")


def test_two_connections_are_two_identities(served, socket_path):
    """Even when both insist on the same name."""
    _server, _seen = served
    first = _call(socket_path, "whoami", {"clientId": "worker"})["result"]["clientId"]
    second = _call(socket_path, "whoami", {"clientId": "worker"})["result"]["clientId"]
    assert first != second


def test_one_connection_keeps_one_identity_across_calls(served, socket_path):
    """A grant that expired every request would be no grant at all."""
    _server, _seen = served
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.connect(socket_path)
    try:
        with conn.makefile("rwb") as stream:
            answers = []
            for _ in range(3):
                stream.write(
                    (json.dumps({"jsonrpc": "2.0", "id": 1, "method": "whoami", "params": {}}) + "\n").encode()
                )
                stream.flush()
                answers.append(json.loads(stream.readline().decode())["result"]["clientId"])
    finally:
        conn.close()
    assert len(set(answers)) == 1


def test_an_identity_does_not_outlive_its_connection():
    """A serving thread that reused a binding would answer as the last client."""
    with identity.bound("cl-first"):
        assert identity.current() == "cl-first"
    assert identity.current() == ""


def test_a_label_is_bounded_and_single_line():
    """It is caller-written text on its way into a log file."""
    stored = identity.label_of("a" * 500 + "\nsecond line")
    assert len(stored) <= identity.MAX_LABEL_LENGTH
    assert "\n" not in stored


def test_a_label_is_not_an_identity(served, socket_path):
    """Recorded for a human reading the log, with nothing hanging off it."""
    _server, _seen = served
    with identity.bound("cl-abcdef12", "pretending-to-be-someone"):
        assert identity.current() == "cl-abcdef12"
        assert identity.current_label() == "pretending-to-be-someone"


def test_identity_is_per_thread_not_per_process():
    """Connections are served on their own threads and must not bleed."""
    seen: dict[str, str] = {}

    def worker(name: str) -> None:
        with identity.bound(name):
            seen[name] = identity.current()

    with identity.bound("cl-main"):
        threads = [threading.Thread(target=worker, args=(f"cl-{i}",)) for i in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert identity.current() == "cl-main"
    assert seen == {f"cl-{i}": f"cl-{i}" for i in range(4)}
