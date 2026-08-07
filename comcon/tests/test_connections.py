"""Two agents are two connections, and the service keeps them apart.

Every guarantee this service makes about co-tenancy is keyed on the connection:
identity is minted when one is accepted, a grant is filed under that identity,
an element is owned by it while it is being written, and its holds are released
when it drops. None of that is observable from inside a single connection, and
none of it is observable at all from a test that calls the handlers in-process
— there `identity.current()` is empty, both halves of consent fall through to
the caller's claimed `clientId`, and a client that borrowed another's name would
look exactly like a client that could not.

So these tests hold two sockets open at the same time, against the real server,
and ask the questions that only have answers when there are two of somebody: do
they get different identities, can one spend the other's grant, does dropping
one take anything from the other, and does the audit log tell them apart.

The rule they exist to defend is stated in `transport.py`: whatever opens this
socket on an agent's behalf opens one connection per agent, never one for the
whole server.
"""

from __future__ import annotations

import json
import socket
import time

import pytest

from desktop_service import audit, holds, security, server


@pytest.fixture(autouse=True)
def clean_registry():
    yield
    for element_id in list(holds._holds):
        holds.release(element_id)


class Connection:
    """One client's socket, with the identity the service issued it."""

    def __init__(self, path: str) -> None:
        self._conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._conn.connect(path)
        self._stream = self._conn.makefile("rwb")
        self._next_id = 0
        self.client_id = ""

    def call(self, method: str, params: dict | None = None) -> dict:
        self._next_id += 1
        request = {
            "jsonrpc": "2.0",
            "id": self._next_id,
            "method": method,
            "params": params or {},
        }
        self._stream.write((json.dumps(request) + "\n").encode())
        self._stream.flush()
        return json.loads(self._stream.readline().decode())

    def hello(self, name: str) -> str:
        """Introduce the connection and learn the identity it was issued.

        `hello` returns it deliberately: a client is allowed to know what it
        will be called without being trusted to say so.
        """
        answer = self.call("hello", {"protocolVersion": "1.0", "clientId": name})
        self.client_id = answer["result"]["clientId"]
        return self.client_id

    def close(self) -> None:
        self._stream.close()
        self._conn.close()


@pytest.fixture()
def two_clients(tmp_path, monkeypatch):
    """A real server with two connections open at once."""
    consent = security.Consent(security.Ceiling(classes=frozenset(security.OPERATION_CLASSES)))
    monkeypatch.setattr(server, "_consent", consent)
    audit_path = tmp_path / "audit.jsonl"
    monkeypatch.setattr(server, "_audit", audit.AuditLog(audit_path))

    path = str(tmp_path / "two.sock")
    srv = server.build_server(path)
    srv.start()
    first = Connection(path)
    second = Connection(path)
    first.hello("the-drafting-agent")
    second.hello("the-reviewing-agent")
    try:
        yield first, second, audit_path
    finally:
        for connection in (first, second):
            try:
                connection.close()
            except OSError:
                pass
        srv.stop()


def _denial(answer: dict) -> dict:
    return answer.get("error", {}).get("data", {}).get("detail", {})


def _granted_to(connection: Connection, **claim) -> list[str]:
    """What the service says this connection holds, asked through a refusal.

    `focusWindow` is an `activate` method against a window id that exists
    nowhere, so consent answers before anything reaches a desktop and the
    denial names what the caller actually holds. Every client holds `observe`
    without asking; the interesting entries are the ones somebody was granted.
    """
    params = {"windowId": "win-nothing", **claim}
    return _denial(connection.call("focusWindow", params)).get("grantedOperationClasses", [])


def _wait_until(predicate, *, seconds: float = 2.0) -> bool:
    """Disconnect cleanup happens on the serving thread, not on ours."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_two_connections_are_two_clients(two_clients) -> None:
    first, second, _audit_path = two_clients
    assert first.client_id and second.client_id
    assert first.client_id != second.client_id


def test_a_grant_follows_the_connection_and_not_the_name(two_clients) -> None:
    """The grant one connection asked for is not spendable on the other."""
    first, second, _audit_path = two_clients
    first.call("grantScope", {"operationClasses": ["edit"]})

    # Both are refused: neither was granted `activate`. What differs is what the
    # service says each of them holds.
    assert "edit" in _granted_to(first)
    assert "edit" not in _granted_to(second)


def test_a_connection_cannot_borrow_a_grant_by_claiming_the_name(two_clients) -> None:
    """The interesting attack is the cheap one: say you are the other client.

    The first connection sends its own issued id, which is what an honest client
    does with what `hello` told it. That is the case worth testing: if the name
    in the params were consulted, the second connection repeating it would be
    holding the first one's grant.
    """
    first, second, _audit_path = two_clients
    first.call("grantScope", {"operationClasses": ["edit"], "clientId": first.client_id})

    assert "edit" not in _granted_to(second, clientId=first.client_id)


def test_a_grant_asked_for_under_another_name_is_still_the_askers_own(two_clients) -> None:
    """The other half of the same claim: the grant lands where it was earned.

    A grant filed under a name the caller invented would be worse than a refused
    one — real, recorded, consulted for nobody.
    """
    first, second, _audit_path = two_clients
    second.call("grantScope", {"operationClasses": ["edit"], "clientId": first.client_id})

    assert "edit" in _granted_to(second)
    assert "edit" not in _granted_to(first)


def test_a_hold_belongs_to_a_connection_and_dies_with_it(two_clients) -> None:
    """Disconnect releases that connection's holds, and only those."""
    first, second, _audit_path = two_clients
    holds.acquire("el-first", first.client_id, "typeText")
    holds.acquire("el-second", second.client_id, "typeText")

    second.close()

    assert _wait_until(lambda: holds.holder("el-second") is None)
    still_held = holds.holder("el-first")
    assert still_held is not None
    assert still_held.client_id == first.client_id


def test_the_audit_log_tells_the_two_connections_apart(two_clients) -> None:
    """Attribution is the part that has to survive a client lying about itself."""
    first, second, audit_path = two_clients
    first.call("focusWindow", {"windowId": "win-nothing"})
    second.call("focusWindow", {"windowId": "win-nothing", "clientId": "the-drafting-agent"})

    records = [json.loads(line) for line in audit_path.read_text().splitlines() if line]
    focus = [record for record in records if record["method"] == "focusWindow"]
    assert [record["clientId"] for record in focus] == [first.client_id, second.client_id]

    # A name claimed after the handshake does not even become a label: the one
    # this connection introduced itself with is the one the log keeps.
    assert focus[1]["clientLabel"] == "the-reviewing-agent"


def test_a_stop_pulled_on_one_connection_revokes_the_others_grant(two_clients) -> None:
    """Today's behaviour, written down so that changing it has to be deliberate.

    `emergencyStop` is classed `observe`, so any connection may pull it, and it
    revokes every grant on the service including the ones it did not issue. That
    is the first entry in #12, accepted there because the only thing that could
    reach this socket was on the same single-user machine. #34 ends that
    justification: a client holding a URL and a credential is not on the box, so
    this is a blocker on the network-facing layer rather than a documented
    shrug. What replaces it cannot be written until it is settled whether one
    server serves one person or several.
    """
    first, second, _audit_path = two_clients
    first.call("grantScope", {"operationClasses": ["edit"]})
    assert "edit" in _granted_to(first)

    stopped = second.call("emergencyStop", {"reason": "a stranger pulled it"})
    assert stopped["result"]["stopped"] is True
    assert stopped["result"]["grantsRevoked"] >= 1

    assert "edit" not in _granted_to(first)
