"""The send gate: composing is not sending, and the last inch is the least
reliable part.

These tests go through the real handlers — the same seam a client's call
arrives on — because the gap this gate closes is exactly that ``invokeElement``
returns ``ok: true`` when the action call returned true, regardless of whether
the field actually transmitted. The mutation-between-attest-and-commit test
proves the gate refuses; the "4" foot-gun test proves that a commit whose
action returned success but whose field was not cleared is reported as failure.
"""

from __future__ import annotations

import pytest

from desktop_service import audit, security, send_gate, server, state
from desktop_service.errors import DesktopError, ErrorCode


class FakeField:
    """An editable field whose contents the test controls."""

    def __init__(self, text: str = "", actions: list[str] | None = None) -> None:
        self.text = text
        self._actions = actions if actions is not None else ["activate"]
        self.action_called = False

    def do_action(self, name: str) -> bool:
        self.action_called = True
        return True


@pytest.fixture
def desktop(tmp_path, monkeypatch):
    """A server with a granted client, a fake field, and no real toolkit."""
    field = FakeField(text="hello world")

    consent = security.Consent(
        security.Ceiling(classes=frozenset(security.OPERATION_CLASSES))
    )
    log = audit.AuditLog(tmp_path / "audit.jsonl")
    monkeypatch.setattr(server, "_consent", consent)
    monkeypatch.setattr(server, "_audit", log)

    monkeypatch.setattr(server, "_resolve_element", lambda element_id: field)
    monkeypatch.setattr(
        server.loop, "call_on_loop", lambda fn, timeout=None: fn()
    )
    monkeypatch.setattr(
        server.atspi, "read_for_attest", lambda obj: obj.text or None
    )
    monkeypatch.setattr(
        server.atspi, "actions_of", lambda obj: list(obj._actions)
    )
    monkeypatch.setattr(
        server.atspi, "do_action", lambda obj, name: obj.do_action(name)
    )
    monkeypatch.setattr(
        server,
        "_snapshot",
        lambda: state.Snapshot(revision=1, windows={}, values={}),
    )
    monkeypatch.setattr(
        server, "_element_scope", lambda element_id: ("win-a", "app-a")
    )

    # Fresh register per test, so one test's attestation does not leak into
    # another's. Module-level state, cleared like holds._holds is.
    send_gate._attestations.clear()
    send_gate._counter = 0

    built = server.build_server(str(tmp_path / "test.sock"))
    built._handlers["grantScope"](
        {"operationClasses": ["edit", "submit", "destructive"], "clientId": "agent"}
    )
    return built, field, log


def call(built, method, **params):
    return built._handlers[method](params)


# --- attestation ----------------------------------------------------------


def test_attest_returns_an_id_and_a_ttl(desktop):
    srv, _, _ = desktop
    result = call(srv, "attestElement", elementId="el-1", clientId="agent")
    assert "attestationId" in result
    assert result["expiresInMs"] > 0


def test_attest_needs_no_grant(desktop):
    """observe class — a client with nothing can still snapshot a field."""
    srv, _, _ = desktop
    result = call(srv, "attestElement", elementId="el-1", clientId="nobody")
    assert "attestationId" in result


def test_a_masked_field_is_refused(desktop, monkeypatch):
    """A password field has nothing honest to compare against."""
    srv, _, _ = desktop
    monkeypatch.setattr(server.atspi, "read_for_attest", lambda obj: None)
    with pytest.raises(DesktopError) as raised:
        call(srv, "attestElement", elementId="el-pw", clientId="agent")
    assert raised.value.code == ErrorCode.ACTION_NOT_SUPPORTED


# --- commit ---------------------------------------------------------------


def test_a_commit_on_an_unchanged_field_sends(desktop):
    """Attest, then commit without mutation: the action fires and the field clears."""
    srv, field, _ = desktop
    original_do = field.do_action

    def clearing(name: str) -> bool:
        original_do(name)
        field.text = ""
        return True

    field.do_action = clearing

    attest = call(srv, "attestElement", elementId="el-1", clientId="agent")
    result = call(
        srv,
        "commitElement",
        elementId="el-1",
        attestationId=attest["attestationId"],
        confirm=True,
        clientId="agent",
    )
    assert result["ok"] is True
    assert field.action_called


def test_commit_requires_confirm(desktop):
    """destructive class — confirm is how the caller says it meant this one."""
    srv, _, _ = desktop
    attest = call(srv, "attestElement", elementId="el-1", clientId="agent")
    with pytest.raises(DesktopError) as raised:
        call(
            srv,
            "commitElement",
            elementId="el-1",
            attestationId=attest["attestationId"],
            clientId="agent",
        )
    assert raised.value.code == ErrorCode.PERMISSION_DENIED


# --- the acceptance criteria -----------------------------------------------


def test_a_mutation_between_attest_and_commit_is_refused(desktop):
    """The field changed underneath the caller. The gate must refuse and name why.

    This is the core acceptance criterion: a commit must re-read the target and
    refuse when it differs from what was approved, with the difference named.
    """
    srv, field, _ = desktop
    attest = call(srv, "attestElement", elementId="el-1", clientId="agent")

    # Something mutated the field between attest and commit.
    field.text = "hello world CHANGED"

    with pytest.raises(DesktopError) as raised:
        call(
            srv,
            "commitElement",
            elementId="el-1",
            attestationId=attest["attestationId"],
            confirm=True,
            clientId="agent",
        )
    assert raised.value.code == ErrorCode.PERMISSION_DENIED
    assert "changed" in raised.value.message.lower()
    assert not field.action_called, "a refused commit must not trigger the action"


def test_the_four_footgun_is_reported_as_failure(desktop):
    """The action call returned true but the field was not cleared.

    This is the exact bug from issue #41: ``Atspi.generate_keyboard_event``
    returned success and typed '4' instead of pressing Return. The synth said
    yes; the field was not cleared; the message was not sent. Success asserted
    from the action call's return would have missed it entirely. The gate checks
    the effect: a field still populated after the action is a commit that did
    not send.
    """
    srv, field, _ = desktop
    attest = call(srv, "attestElement", elementId="el-1", clientId="agent")

    # The action "succeeds" (returns True) but does not clear the field — the
    # foot-gun: the synth reported success, nothing was transmitted.
    result = call(
        srv,
        "commitElement",
        elementId="el-1",
        attestationId=attest["attestationId"],
        confirm=True,
        clientId="agent",
    )
    assert result["ok"] is False, (
        "a commit whose field was not cleared must be reported as failure, "
        "regardless of what the action call returned"
    )
    assert field.action_called, "the action must still have been attempted"
    progress = result.get("progress", {})
    assert progress.get("effect") == "field-still-populated"


def test_a_successful_commit_clears_the_field_and_reports_ok(desktop):
    srv, field, _ = desktop
    attest = call(srv, "attestElement", elementId="el-1", clientId="agent")

    # The action succeeds AND clears the field — what a real Send does.
    original_do_action = field.do_action

    def clearing_action(name: str) -> bool:
        original_do_action(name)
        field.text = ""
        return True

    field.do_action = clearing_action

    result = call(
        srv,
        "commitElement",
        elementId="el-1",
        attestationId=attest["attestationId"],
        confirm=True,
        clientId="agent",
    )
    assert result["ok"] is True


# --- one attestation, one commit ------------------------------------------


def test_an_attestation_can_only_be_used_once(desktop):
    srv, _, _ = desktop
    attest = call(srv, "attestElement", elementId="el-1", clientId="agent")

    # First commit: field is unchanged, action fires.
    field = desktop[1]
    original_do = field.do_action
    def clearing(name):
        original_do(name)
        field.text = ""
        return True
    field.do_action = clearing
    call(
        srv,
        "commitElement",
        elementId="el-1",
        attestationId=attest["attestationId"],
        confirm=True,
        clientId="agent",
    )

    # Second commit with the same attestation: refused.
    with pytest.raises(DesktopError) as raised:
        call(
            srv,
            "commitElement",
            elementId="el-1",
            attestationId=attest["attestationId"],
            confirm=True,
            clientId="agent",
        )
    assert raised.value.code == ErrorCode.PERMISSION_DENIED
    assert "already" in raised.value.message.lower()


def test_an_attestation_from_one_client_cannot_commit_as_another(desktop):
    srv, _, _ = desktop
    built = desktop[0]
    built._handlers["grantScope"](
        {"operationClasses": ["edit", "submit", "destructive"], "clientId": "other"}
    )
    attest = call(srv, "attestElement", elementId="el-1", clientId="agent")
    with pytest.raises(DesktopError) as raised:
        call(
            srv,
            "commitElement",
            elementId="el-1",
            attestationId=attest["attestationId"],
            confirm=True,
            clientId="other",
        )
    assert raised.value.code == ErrorCode.PERMISSION_DENIED
    assert "different client" in raised.value.message.lower()


# --- the register itself --------------------------------------------------


def test_the_register_is_bounded():
    send_gate._attestations.clear()
    send_gate._counter = 0
    for i in range(send_gate._MAX_ATTESTATIONS + 50):
        send_gate.attest(client_id="c", element_id=f"el-{i}", text="t")
    # The register never exceeds its bound, no matter how many attests arrive.
    assert len(send_gate._attestations) <= send_gate._MAX_ATTESTATIONS
    send_gate._attestations.clear()
    send_gate._counter = 0


def test_the_audit_log_never_contains_what_was_typed(desktop):
    """The field's text is evidence, not data; it must never reach the log."""
    srv, _, log = desktop
    attest = call(srv, "attestElement", elementId="el-1", clientId="agent")
    call(
        srv,
        "commitElement",
        elementId="el-1",
        attestationId=attest["attestationId"],
        confirm=True,
        clientId="agent",
    )
    for entry in log.tail():
        blob = json_dumps(entry)
        assert "hello world" not in blob, (
            "the field's contents reached the audit log — the one sink the "
            "redaction policy cannot reach after the fact"
        )


def json_dumps(obj):
    import json

    return json.dumps(obj)
