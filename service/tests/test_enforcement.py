"""Whether enforcement is actually in the path, asked of the server itself.

The consent module is tested on its own next door, and passing there proves it
decides correctly. It does not prove that anything asks it. These tests go
through `build_server`, the same registration seam a real client's call goes
through, because the only interesting failure mode of a permission system is
the method that quietly does not use it.
"""

from __future__ import annotations

import pytest

from desktop_service import audit, protocol_generated, security, server
from desktop_service.errors import DesktopError, ErrorCode


@pytest.fixture
def built(tmp_path, monkeypatch):
    """A server whose consent and audit log are ours, restored afterwards."""
    consent = security.Consent(security.Ceiling(classes=frozenset(security.OPERATION_CLASSES)))
    log = audit.AuditLog(tmp_path / "audit.jsonl")
    monkeypatch.setattr(server, "_consent", consent)
    monkeypatch.setattr(server, "_audit", log)
    built = server.build_server(str(tmp_path / "test.sock"))
    return built, consent, log


def call(built, method, **params):
    return built._handlers[method](params)


ACTING_METHODS = [
    method
    for method, klass in protocol_generated.OPERATION_CLASS.items()
    if klass != "observe"
]


@pytest.mark.parametrize("method", ACTING_METHODS)
def test_every_acting_method_refuses_an_ungranted_client(built, method):
    # Parametrised over the protocol rather than over a hand-written list: a
    # method added later is guarded by this test on the day it is added, which
    # is the only day anybody would have remembered to guard it by hand.
    srv, _, _ = built
    with pytest.raises(DesktopError) as raised:
        call(srv, method, clientId="nobody")
    assert raised.value.code == ErrorCode.PERMISSION_DENIED, method


def test_observation_needs_no_grant(built):
    srv, _, _ = built
    assert call(srv, "getRevision", clientId="nobody")["revision"] >= 0


def test_a_client_may_ask_for_a_grant_while_holding_nothing(built):
    # Refusing the request for permission is not a boundary; it is a dead end.
    srv, _, _ = built
    granted = call(srv, "grantScope", operationClasses=["edit"], clientId="nobody")
    assert "edit" in granted["operationClasses"]


def test_the_refusal_is_recorded_with_its_reason(built):
    srv, _, log = built
    with pytest.raises(DesktopError):
        call(srv, "focusWindow", windowId="win-1", clientId="nobody")
    entry = log.tail()[-1]
    assert entry["decision"] == "denied"
    assert entry["method"] == "focusWindow"
    assert entry["errorCode"] == "PERMISSION_DENIED"
    assert "activate" in entry["reason"]


def test_an_allowed_call_is_recorded_too(built):
    srv, _, log = built
    call(srv, "getRevision", clientId="watcher")
    entry = log.tail()[-1]
    assert entry["decision"] == "allowed"
    assert entry["clientId"] == "watcher"


def test_a_failing_call_is_recorded_as_failed_rather_than_omitted(built):
    # An action that was permitted and then broke is a different fact from one
    # that never ran, and a log that only has the denials loses it.
    srv, consent, log = built
    consent.grant("actor", classes=["activate"])
    with pytest.raises(DesktopError):
        call(srv, "focusWindow", windowId="win-does-not-exist", clientId="actor")
    entry = log.tail()[-1]
    assert entry["decision"] == "failed"
    assert entry["errorCode"]


def test_the_log_never_contains_what_was_typed(built):
    # The audit log is the fourth sink, and the easiest one to forget.
    srv, consent, log = built
    consent.grant("actor", classes=["edit"])
    with pytest.raises(DesktopError):
        call(srv, "typeText", elementId="el-nope", text="hunter2 my secret passphrase", clientId="actor")
    assert "hunter2" not in log.path.read_text()
    assert "passphrase" not in log.path.read_text()


def test_a_submit_needs_confirmation_even_with_the_class_granted(built):
    srv, consent, _ = built
    consent.grant("actor", classes=["submit"])
    with pytest.raises(DesktopError) as raised:
        call(srv, "invokeElement", elementId="el-1", actionId="page.save", clientId="actor")
    assert raised.value.code == ErrorCode.PERMISSION_DENIED
    assert "confirm" in raised.value.message


def test_emergency_stop_refuses_acting_afterwards(built):
    srv, consent, _ = built
    consent.grant("actor", classes=["activate"])
    call(srv, "emergencyStop", reason="hands off", clientId="human")
    with pytest.raises(DesktopError) as raised:
        call(srv, "focusWindow", windowId="win-1", clientId="actor")
    assert "stop" in raised.value.message.lower()


def test_emergency_stop_leaves_observation_working(built):
    # Somebody has to be able to see what state the desktop was left in.
    srv, _, _ = built
    call(srv, "emergencyStop", clientId="human")
    assert call(srv, "getRevision", clientId="anyone")["revision"] >= 0


def test_a_stop_can_be_cleared_only_on_purpose(built):
    srv, consent, _ = built
    call(srv, "emergencyStop", clientId="human")
    assert consent.stopped
    call(srv, "getRevision", clientId="anyone")
    assert consent.stopped, "an unrelated call must not clear a stop as a side effect"
    call(srv, "emergencyStop", clear=True, clientId="human")
    assert not consent.stopped


def test_the_stop_reports_what_it_could_not_call_back(built):
    # There is no un-click. The count is the honest version of that sentence.
    srv, _, _ = built
    result = call(srv, "emergencyStop", clientId="human")
    assert "inFlight" in result


def test_the_audit_tail_is_readable_without_a_grant(built):
    srv, _, _ = built
    call(srv, "getRevision", clientId="watcher")
    tail = call(srv, "auditTail", limit=5, clientId="watcher")
    assert tail["entries"]
    assert tail["path"].endswith("audit.jsonl")


def test_the_tail_reports_records_it_failed_to_write(built):
    srv, _, _ = built
    tail = call(srv, "auditTail", clientId="watcher")
    assert tail["writeFailures"] == 0


def test_grant_scope_is_itself_recorded(built):
    # Who asked for what, and when, is the first question after an incident.
    srv, _, log = built
    call(srv, "grantScope", operationClasses=["edit"], reason="typing a reply", clientId="actor")
    methods = [entry["method"] for entry in log.tail(10)]
    assert "grantScope" in methods


def test_a_narrower_grant_cannot_reach_another_application(built, monkeypatch):
    srv, consent, _ = built
    monkeypatch.setattr(server, "_application_of", lambda params: "Discord")
    monkeypatch.setattr(server, "_needs_application", lambda klass: True)
    consent.grant("actor", classes=["edit"], applications=["text editor"])
    with pytest.raises(DesktopError) as raised:
        call(srv, "typeText", elementId="el-1", text="hi", clientId="actor")
    assert raised.value.code == ErrorCode.PERMISSION_DENIED


def test_an_unidentifiable_target_is_refused_while_a_list_is_in_force(built, monkeypatch):
    # A call whose target cannot be named, on a desktop where the user has said
    # which applications may be touched, is exactly the call to refuse.
    srv, consent, _ = built
    monkeypatch.setattr(server, "_application_of", lambda params: server._UNIDENTIFIED)
    monkeypatch.setattr(server, "_needs_application", lambda klass: True)
    consent.grant("actor", classes=["edit"], applications=["text editor"])
    with pytest.raises(DesktopError):
        call(srv, "typeText", elementId="el-1", text="hi", clientId="actor")


def test_enforcement_is_installed_at_the_registration_seam(built):
    # Asserted against the code: a handler registered without the guard would
    # pass every test above that happens not to name it.
    import inspect as py_inspect

    source = py_inspect.getsource(server.build_server)
    assert "_guarded(method" in source
    # And nothing may register directly on the underlying server, going around it.
    body = py_inspect.getsource(server)
    assert body.count("base.register(") == 0


def test_the_guard_survives_parameters_the_schema_has_not_vetted_yet(built):
    # Consent runs before validation, so these reach it raw. A guard that threw
    # on a hostile parameter would turn "denied" into "internal error", which
    # is a different answer and a worse one.
    srv, _, log = built
    for hostile in ({"clientId": 5}, {"windowId": ["x"]}, {"elementId": {"a": 1}}, {}):
        with pytest.raises(DesktopError) as raised:
            call(srv, "focusWindow", **hostile)
        assert raised.value.code in (ErrorCode.PERMISSION_DENIED, ErrorCode.INVALID_PARAMS)


def test_an_oversized_identifier_does_not_become_an_oversized_log_line(built):
    srv, _, log = built
    with pytest.raises(DesktopError):
        call(srv, "focusWindow", windowId="w" * 100_000, clientId="nobody")
    assert len(log.path.read_text()) < 4_000
