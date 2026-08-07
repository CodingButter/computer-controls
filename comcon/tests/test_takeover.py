"""A person reaching for their own field, asked of the server itself.

The rule is tested next door in `test_presence.py`, which proves it decides
correctly. These go through `build_server` — the same seam a real client's call
arrives at — because a withdrawal that no method consults is a withdrawal in
name only.
"""

from __future__ import annotations

import pytest

from desktop_service import audit, presence, security, server
from desktop_service.errors import DesktopError, ErrorCode


class Clock:
    def __init__(self) -> None:
        self.t = 500.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


@pytest.fixture
def built(tmp_path, monkeypatch):
    consent = security.Consent(security.Ceiling(classes=frozenset(security.OPERATION_CLASSES)))
    consent.grant("writer", classes=frozenset(security.OPERATION_CLASSES))
    clock = Clock()
    desk = {"idle": 90_000, "active": "3001"}
    watch = presence.Watch(lambda: desk["idle"], lambda: desk["active"], now=clock)
    monkeypatch.setattr(server, "_consent", consent)
    monkeypatch.setattr(server, "_audit", audit.AuditLog(tmp_path / "audit.jsonl"))
    monkeypatch.setattr(server, "_presence", watch)
    srv = server.build_server(str(tmp_path / "test.sock"))
    return srv, watch, desk, clock


def call(srv, method, **params):
    return srv._handlers[method](params)


def taken(watch):
    watch.withhold("el-body", "3001", taken_from="writer")


def test_writing_into_a_field_the_person_took_is_refused(built):
    srv, watch, _, _ = built
    taken(watch)
    with pytest.raises(DesktopError) as raised:
        call(srv, "typeText", elementId="el-body", text="hello", clientId="writer")
    assert raised.value.code == ErrorCode.PERMISSION_DENIED
    assert raised.value.detail["takenFrom"] == "writer"


def test_the_client_that_lost_it_cannot_get_it_back_by_asking_again(built):
    # The whole design: the agent does not get a vote. There is no parameter,
    # no confirmation and no second grant that reaches past this.
    srv, watch, _, _ = built
    taken(watch)
    call(srv, "grantScope", operationClasses=["edit"], clientId="writer")
    with pytest.raises(DesktopError):
        call(srv, "typeText", elementId="el-body", text="hello", clientId="writer", confirm=True)


def test_a_second_agent_is_no_more_welcome_than_the_first(built):
    # The claim belongs to the element, not to the client it was taken from.
    srv, watch, _, _ = built
    taken(watch)
    with pytest.raises(DesktopError):
        call(srv, "editText", elementId="el-body", find="a", replaceWith="b", clientId="other")


def test_a_batched_write_is_refused_by_the_same_rule(built):
    srv, watch, _, _ = built
    taken(watch)
    with pytest.raises(DesktopError) as raised:
        call(
            srv,
            "performActions",
            confirm=True,
            clientId="writer",
            actions=[{"method": "setElementValue", "params": {"elementId": "el-body", "value": "x"}}],
        )
    assert raised.value.code == ErrorCode.PERMISSION_DENIED


def test_reading_the_field_is_never_refused(built):
    # Somebody taking a field is a reason to stop writing in it, not a reason to
    # go blind. An agent that cannot observe cannot even tell it has stopped.
    srv, watch, _, _ = built
    taken(watch)
    with pytest.raises(DesktopError) as raised:
        call(srv, "getElement", elementId="el-body", clientId="writer")
    assert raised.value.code != ErrorCode.PERMISSION_DENIED


def test_a_field_nobody_took_is_not_refused_on_presence_grounds(built):
    srv, _, _, _ = built
    with pytest.raises(DesktopError) as raised:
        call(srv, "typeText", elementId="el-nothing", text="hello", clientId="writer")
    assert raised.value.code != ErrorCode.PERMISSION_DENIED


def test_the_field_returns_once_the_person_has_moved_on(built):
    srv, watch, desk, clock = built
    taken(watch)
    clock.advance(presence.HANDBACK_MS / 1000 + 1)
    desk["idle"] = 120_000
    with pytest.raises(DesktopError) as raised:
        call(srv, "typeText", elementId="el-body", text="hello", clientId="writer")
    assert raised.value.code != ErrorCode.PERMISSION_DENIED


def test_the_refusal_is_recorded(built):
    srv, watch, _, _ = built
    taken(watch)
    with pytest.raises(DesktopError):
        call(srv, "typeText", elementId="el-body", text="hello", clientId="writer")
    entry = server._audit.tail()[-1]
    assert entry["decision"] == "denied"
    assert entry["errorCode"] == ErrorCode.PERMISSION_DENIED


def test_an_in_flight_write_stops_when_the_person_starts_working_in_that_window(built):
    srv, watch, desk, _ = built
    progress: dict = {}
    desk["idle"] = 10  # somebody just touched the keyboard
    assert server._yielded(progress, "el-body", "3001", "writer") is True
    assert progress["yieldedTo"] == "user"
    # Stopped and withheld in one breath, so calling again cannot win the race.
    assert watch.holder_of("el-body") is not None


def test_an_in_flight_write_continues_while_the_person_works_somewhere_else(built):
    srv, watch, desk, _ = built
    desk["idle"] = 10
    desk["active"] = "4002"  # their own chat window, not ours
    progress: dict = {}
    assert server._yielded(progress, "el-body", "3001", "writer") is False
    assert progress == {}
    assert watch.holder_of("el-body") is None


def test_a_window_that_could_not_be_identified_does_not_stop_the_write(built):
    srv, _, desk, _ = built
    desk["idle"] = 10
    assert server._yielded({}, "el-body", "", "writer") is False
