"""The proof the agent cannot author, end to end through the real handlers.

The send gate proved that a field's text did not move between attest and
commit. That is one criterion. This suite holds the four this amendment adds
around it, and each test is named for the acceptance criterion it stands for:

1. The attestation is assembled by the service, below the layer the agent
   reaches, and carries the revision it was taken at.
2. A commit whose field moved since the proof fails.
3. A criterion the service cannot decide is reported unchecked — never
   verified, because a proof that launders a claim into an official-looking
   field reads as confirmation and is worse than no proof at all.
4. The criteria are carried on the grant, at dispatch, and the worker cannot
   choose its own.

They go through ``build_server``'s registration seam rather than calling the
module functions, because the only interesting failure mode of a gate is the
method that quietly does not use it.
"""

from __future__ import annotations

import json

import pytest

from desktop_service import (
    attestation,
    audit,
    security,
    send_gate,
    server,
    state,
)
from desktop_service.errors import DesktopError, ErrorCode


class FakeField:
    """An editable field whose contents and reachability the test controls."""

    def __init__(self, text: str = "hello world") -> None:
        self.text = text
        self.action_called = False

    def do_action(self, name: str) -> bool:
        self.action_called = True
        self.text = ""
        return True


class FakeDeltas:
    """The delta engine's answer, with the test holding the pen.

    Only ``since`` is used by the gate, and it returns exactly the shape the
    real engine returns — attribution already decided, because deciding it
    twice would mean the gate and the rest of the service could disagree about
    who moved a field.
    """

    def __init__(self) -> None:
        self.changes: list[dict] = []
        self.complete = True
        self.asked_as: list[str] = []
        self.asked_since: list[int] = []

    def since(self, revision: int, asking_client: str = "") -> dict:
        self.asked_as.append(asking_client)
        self.asked_since.append(revision)
        return {
            "changes": list(self.changes),
            "revision": 1,
            "complete": self.complete,
        }


@pytest.fixture
def desktop(tmp_path, monkeypatch):
    """A server with a granted client, a fake field, and no real toolkit."""
    field = FakeField()
    deltas = FakeDeltas()

    consent = security.Consent(
        security.Ceiling(classes=frozenset(security.OPERATION_CLASSES))
    )
    log = audit.AuditLog(tmp_path / "audit.jsonl")
    monkeypatch.setattr(server, "_consent", consent)
    monkeypatch.setattr(server, "_audit", log)
    monkeypatch.setattr(server, "_deltas", deltas)

    monkeypatch.setattr(server, "_resolve_element", lambda element_id: field)
    monkeypatch.setattr(server.loop, "call_on_loop", lambda fn, timeout=None: fn())
    monkeypatch.setattr(server.atspi, "read_for_attest", lambda obj: obj.text or None)
    monkeypatch.setattr(server.atspi, "actions_of", lambda obj: ["activate"])
    monkeypatch.setattr(server.atspi, "do_action", lambda obj, name: obj.do_action(name))
    monkeypatch.setattr(
        server, "_snapshot", lambda: state.Snapshot(revision=1, windows={}, values={})
    )
    monkeypatch.setattr(server, "_element_scope", lambda element_id: ("win-a", "app-a"))

    send_gate._attestations.clear()
    send_gate._counter = 0

    built = server.build_server(str(tmp_path / "test.sock"))
    return built, field, deltas, log


def call(built, method, **params):
    return built._handlers[method](params)


def grant(built, *, client="agent", criteria=None):
    params = {
        "operationClasses": ["edit", "submit", "destructive"],
        "clientId": client,
    }
    if criteria is not None:
        params["criteria"] = criteria
    return built._handlers["grantScope"](params)


def commit(built, attest, *, client="agent"):
    return call(
        built,
        "commitElement",
        elementId="el-1",
        attestationId=attest["attestationId"],
        confirm=True,
        clientId=client,
    )


def summaries(log) -> list[str]:
    return [
        entry["attestation"]
        for entry in log.tail()
        if entry.get("attestation")
    ]


# ---------------------------------------------------------------------------
# Criterion 1 — the service assembles the proof, and stamps it
# ---------------------------------------------------------------------------


def test_the_verdict_is_recorded_by_the_service_not_supplied_by_the_caller(desktop):
    built, _, _, log = desktop
    grant(built)
    attest = call(built, "attestElement", elementId="el-1", clientId="agent")

    commit(built, attest)

    recorded = summaries(log)
    assert recorded, "the commit produced no verdict for a reviewer to read"
    assert "contents-match=verified" in recorded[-1]


def test_the_verdict_carries_the_revision_the_proof_was_taken_at(desktop):
    """A proof is a photograph, and a photograph is stamped."""
    built, _, _, log = desktop
    grant(built)
    call(built, "attestElement", elementId="el-1", clientId="agent")
    attest = call(built, "attestElement", elementId="el-1", clientId="agent")

    commit(built, attest)

    assert summaries(log)[-1].startswith(f"r{server._registry.revision} ")


def test_a_commit_cannot_carry_its_own_evidence(desktop):
    """The agent writes the argument. It has no field to write evidence into."""
    schema = server.protocol_generated.PARAMS_SCHEMA["commitElement"]

    assert schema["additionalProperties"] is False
    assert set(schema["properties"]) == {
        "elementId",
        "attestationId",
        "action",
        "settleMs",
        "confirm",
        "clientId",
    }


def test_the_verdict_is_attributed_as_the_committing_client(desktop):
    """A field this client typed into is not somebody else's interference."""
    built, _, deltas, _ = desktop
    grant(built)
    attest = call(built, "attestElement", elementId="el-1", clientId="agent")

    commit(built, attest)

    assert deltas.asked_as == ["agent"]


def test_the_change_log_is_asked_from_the_proof_not_from_now(desktop):
    """Freshness compares against the photograph's moment, not the present.

    A gate that asked the log "what changed since now" would find stillness by
    construction — the check would pass vacuously in production while every
    test with a fake log stayed green. So the fake records what it was asked,
    and this test pins both ends of the plumbing: the revision stamped at
    attest is the one the log is asked from at commit, and the one the audit
    record carries.
    """
    built, _, deltas, log = desktop
    grant(built)
    server._registry.bump()
    proof_revision = server._registry.revision
    attest = call(built, "attestElement", elementId="el-1", clientId="agent")
    server._registry.bump()
    server._registry.bump()

    commit(built, attest)

    assert deltas.asked_since[-1] == proof_revision
    assert f"r{proof_revision} " in summaries(log)[-1]


# ---------------------------------------------------------------------------
# Criterion 2 — a stale proof does not commit
# ---------------------------------------------------------------------------


def test_a_field_another_party_touched_since_the_proof_cannot_commit(desktop):
    """The ABA case the send gate cannot see: same text, and it still moved."""
    built, field, deltas, _ = desktop
    grant(built)
    attest = call(built, "attestElement", elementId="el-1", clientId="agent")

    # Someone edited the field and edited it back: the text compares equal.
    deltas.changes = [
        {"elementId": "el-1", "attribution": "external", "revision": 9}
    ]

    with pytest.raises(DesktopError) as raised:
        commit(built, attest)

    assert raised.value.code == ErrorCode.ATTESTATION_STALE
    assert not field.action_called, "a stale proof must not reach the action"


def test_a_stale_refusal_names_the_difference(desktop):
    built, _, deltas, _ = desktop
    grant(built)
    attest = call(built, "attestElement", elementId="el-1", clientId="agent")
    deltas.changes = [
        {"elementId": "el-1", "attribution": "external", "revision": 9}
    ]

    with pytest.raises(DesktopError) as raised:
        commit(built, attest)

    assert "unchanged-since-proof mismatch" in raised.value.message
    assert "another party" in raised.value.message


def test_a_change_to_another_element_does_not_make_this_proof_stale(desktop):
    """The revision counter is the desktop's; the approval was about one field."""
    built, _, deltas, _ = desktop
    grant(built)
    attest = call(built, "attestElement", elementId="el-1", clientId="agent")
    deltas.changes = [
        {"elementId": "el-elsewhere", "attribution": "external", "revision": 9}
    ]

    assert commit(built, attest)["ok"] is True


def test_a_refused_commit_still_leaves_a_verdict_behind(desktop):
    """The commit a reviewer most needs the reasons for is the refused one."""
    built, _, deltas, log = desktop
    grant(built)
    attest = call(built, "attestElement", elementId="el-1", clientId="agent")
    deltas.changes = [
        {"elementId": "el-1", "attribution": "external", "revision": 9}
    ]

    with pytest.raises(DesktopError):
        commit(built, attest)

    assert "unchanged-since-proof=mismatch" in summaries(log)[-1]


# ---------------------------------------------------------------------------
# Criterion 3 — unverifiable is unchecked, never verified
# ---------------------------------------------------------------------------


def test_a_change_the_service_cannot_account_for_is_never_verified(desktop):
    built, _, deltas, log = desktop
    grant(built)
    attest = call(built, "attestElement", elementId="el-1", clientId="agent")
    deltas.changes = [
        {"elementId": "el-1", "attribution": "unattributed", "revision": 9}
    ]

    with pytest.raises(DesktopError) as raised:
        commit(built, attest)

    assert raised.value.code == ErrorCode.ATTESTATION_STALE
    assert "unchanged-since-proof=unchecked" in summaries(log)[-1]
    assert "unchanged-since-proof=verified" not in summaries(log)[-1]


def test_a_change_log_that_cannot_see_the_proof_refuses_rather_than_assumes(desktop):
    """Silence from a log that has overflowed is not evidence of stillness."""
    built, field, deltas, _ = desktop
    grant(built)
    attest = call(built, "attestElement", elementId="el-1", clientId="agent")
    deltas.complete = False

    with pytest.raises(DesktopError):
        commit(built, attest)

    assert not field.action_called


def test_a_target_the_desktop_lost_is_refused_before_the_action(desktop):
    built, field, _, log = desktop
    grant(built)
    attest = call(built, "attestElement", elementId="el-1", clientId="agent")

    def gone(element_id):
        raise DesktopError(ErrorCode.ELEMENT_NOT_FOUND, "gone")

    server._resolve_element = gone
    try:
        with pytest.raises(DesktopError) as raised:
            commit(built, attest)
    finally:
        server._resolve_element = lambda element_id: field

    assert raised.value.code == ErrorCode.ELEMENT_NOT_FOUND
    assert "target-resolved=mismatch" in summaries(log)[-1]


def test_the_verdict_reports_the_questions_it_did_not_answer(desktop):
    built, _, _, log = desktop
    grant(built, criteria=["right-recipient", "intent-matches"])
    attest = call(built, "attestElement", elementId="el-1", clientId="agent")

    commit(built, attest)

    recorded = summaries(log)[-1]
    assert "right-recipient=unchecked" in recorded
    assert "intent-matches=unchecked" in recorded


# ---------------------------------------------------------------------------
# Criterion 4 — the criteria are on the grant, not chosen by the worker
# ---------------------------------------------------------------------------


def test_the_grant_declares_the_criteria(desktop):
    built, _, _, _ = desktop
    result = grant(built, criteria=["right-recipient"])

    assert "right-recipient" in result["criteria"]


def test_a_grant_that_declares_nothing_still_faces_the_mechanical_criteria(desktop):
    built, _, _, _ = desktop
    result = grant(built)

    for criterion in attestation.MECHANICAL_CRITERIA:
        assert criterion.name in result["criteria"]


def test_a_grant_cannot_narrow_the_rubric_it_is_judged_against(desktop):
    """Naming one question is not a way of declining the others."""
    built, _, _, _ = desktop
    result = grant(built, criteria=["right-recipient"])

    for criterion in attestation.MECHANICAL_CRITERIA:
        assert criterion.name in result["criteria"]


def test_the_worker_cannot_name_criteria_on_the_commit_itself(desktop):
    """The rubric arrives with the grant, at dispatch, or not at all."""
    assert (
        "criteria"
        not in server.protocol_generated.PARAMS_SCHEMA["commitElement"]["properties"]
    )


def test_a_client_with_no_grant_is_still_judged(desktop):
    """Holding no grant is not a reason to ask fewer questions."""
    built, _, _, _ = desktop

    criteria = server._consent.criteria_for("nobody")

    assert set(criteria) == set(attestation.MECHANICAL_CRITERIA)


def test_a_criterion_this_service_cannot_decide_is_carried_not_refused(desktop):
    """Asking for review must never be worse than asking for nothing."""
    built, _, _, log = desktop
    grant(built, criteria=["is-this-the-agreed-price"])
    attest = call(built, "attestElement", elementId="el-1", clientId="agent")

    commit(built, attest)

    assert "is-this-the-agreed-price=unchecked" in summaries(log)[-1]


# ---------------------------------------------------------------------------
# What the verdict must never carry
# ---------------------------------------------------------------------------


def test_the_verdict_never_carries_the_contents_of_a_field(desktop):
    """Verdicts are facts about the outcome; contents are the value itself."""
    built, field, deltas, log = desktop
    field.text = "the-secret-message"
    grant(built, criteria=["right-recipient"])
    attest = call(built, "attestElement", elementId="el-1", clientId="agent")
    deltas.changes = [
        {"elementId": "el-1", "attribution": "external", "revision": 9}
    ]

    with pytest.raises(DesktopError):
        commit(built, attest)

    for entry in log.tail():
        assert "the-secret-message" not in json.dumps(entry)
