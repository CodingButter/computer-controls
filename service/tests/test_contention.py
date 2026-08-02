"""Two writers, one field — asked of the server rather than the registry.

The registry's own tests next door prove it can refuse. They do not prove
anybody consults it, and the failure this rule exists to prevent is a write
that reached the toolkit without asking. So these go through the real handlers:
the same seam a client's call arrives on, including the batch path, which
dispatches steps through the handler table and would be an obvious place for a
rule to be quietly skipped.
"""

from __future__ import annotations

import threading

import pytest

from desktop_service import audit, holds, security, server, state
from desktop_service.errors import DesktopError, ErrorCode


class FakeField:
    """An editable field that can be made to type slowly, on purpose."""

    def __init__(self) -> None:
        self.text = ""
        self.editable = True
        self.inside = threading.Event()
        self.may_finish: threading.Event | None = None

    def insert(self, chunk: str) -> bool:
        self.inside.set()
        if self.may_finish is not None:
            self.may_finish.wait(5)
        self.text += chunk
        return True


@pytest.fixture
def desktop(tmp_path, monkeypatch):
    """A server with a granted client, two fields, and no real waiting."""
    fields: dict[str, FakeField] = {"el-a": FakeField(), "el-b": FakeField()}

    consent = security.Consent(security.Ceiling(classes=frozenset(security.OPERATION_CLASSES)))
    log = audit.AuditLog(tmp_path / "audit.jsonl")
    monkeypatch.setattr(server, "_consent", consent)
    monkeypatch.setattr(server, "_audit", log)

    monkeypatch.setattr(server, "_resolve_element", lambda element_id: fields[element_id])
    monkeypatch.setattr(server.loop, "call_on_loop", lambda work, timeout=None: work())
    monkeypatch.setattr(server.atspi, "is_editable", lambda obj: obj.editable)
    monkeypatch.setattr(server.atspi, "insert_text", lambda obj, chunk, offset=-1: obj.insert(chunk))
    monkeypatch.setattr(
        server.atspi,
        "text_matches",
        lambda obj, expected, exact: server.atspi.verdict_for(obj.text, expected, exact=exact),
    )
    monkeypatch.setattr(server.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(server, "_snapshot", lambda: state.Snapshot(revision=1, windows={}, values={}))
    monkeypatch.setattr(server, "_element_scope", lambda element_id: ("win-a", "app-a"))

    built = server.build_server(str(tmp_path / "test.sock"))
    for client in ("agent-one", "agent-two"):
        built._handlers["grantScope"]({"operationClasses": ["edit", "submit"], "clientId": client})
    yield built, fields, log
    for element_id in list(holds._holds):
        holds.release(element_id)


def call(built, method, **params):
    return built._handlers[method](params)


def test_the_second_agent_typing_into_one_field_is_refused_while_the_first_is_typing(desktop):
    """The reported bug: two paced sentences interleaving into one field."""
    built, fields, _ = desktop
    fields["el-a"].may_finish = threading.Event()
    outcome: dict = {}

    def first() -> None:
        outcome["first"] = call(
            built, "typeText", elementId="el-a", text="the first agent writes", clientId="agent-one"
        )

    writer = threading.Thread(target=first, daemon=True)
    writer.start()
    assert fields["el-a"].inside.wait(5), "the first agent never began typing"

    with pytest.raises(DesktopError) as refused:
        call(built, "typeText", elementId="el-a", text="and the second one", clientId="agent-two")

    assert refused.value.code == ErrorCode.ELEMENT_HELD
    assert refused.value.detail["heldBy"] == "agent-one"
    assert refused.value.detail["heldMethod"] == "typeText"
    assert "different element" in refused.value.detail["remedy"]

    fields["el-a"].may_finish.set()
    writer.join(5)

    assert outcome["first"]["ok"] is True
    # The sentence that arrived is one sentence, not two shuffled together.
    assert fields["el-a"].text == "the first agent writes"
    assert holds.holder("el-a") is None


def test_a_refused_write_reaches_the_audit_log_as_a_failure(desktop):
    """Whoever was stopped, and whose write stopped them, is a matter of record."""
    built, _, log = desktop
    holds.acquire("el-a", "agent-one", "typeText")

    with pytest.raises(DesktopError):
        call(built, "typeText", elementId="el-a", text="anything", clientId="agent-two")

    entry = log.tail()[-1]
    assert entry["decision"] == "failed"
    assert entry["method"] == "typeText"
    assert entry["errorCode"] == "ELEMENT_HELD"
    assert entry["clientId"] == "agent-two"


def test_a_held_element_refuses_the_step_inside_a_batch_too(desktop):
    """The batch path dispatches handlers itself; the rule has to be under it."""
    built, fields, _ = desktop
    holds.acquire("el-a", "agent-one", "typeText")

    result = call(
        built,
        "performActions",
        clientId="agent-two",
        confirm=True,
        actions=[{"method": "typeText", "params": {"elementId": "el-a", "text": "anything"}}],
    )

    step = result["results"][0]
    assert step["ok"] is False
    assert step["error"]["code"] == "ELEMENT_HELD"
    assert step["error"]["detail"]["heldBy"] == "agent-one"
    assert fields["el-a"].text == ""


def test_a_batch_writing_elsewhere_is_untouched_by_someone_else_s_held_field(desktop):
    built, fields, _ = desktop
    holds.acquire("el-a", "agent-one", "typeText")

    result = call(
        built,
        "performActions",
        clientId="agent-two",
        confirm=True,
        actions=[{"method": "typeText", "params": {"elementId": "el-b", "text": "over here"}}],
    )

    assert result["results"][0]["ok"] is True
    assert fields["el-b"].text == "over here"


def test_two_agents_writing_in_different_fields_of_one_application_both_finish(desktop):
    """Per element, not per application: this is the case the service is for.

    Both writes are pinned inside their inserts at once. If ownership were
    coarser than one element the second would be refused, and if it were a
    queue the second would still be waiting when the assertion runs.
    """
    built, fields, _ = desktop
    for field in fields.values():
        field.may_finish = threading.Event()
    outcome: dict = {}

    def write(element_id: str, client_id: str) -> None:
        outcome[client_id] = call(
            built, "typeText", elementId=element_id, text="a sentence", clientId=client_id
        )

    threads = [
        threading.Thread(target=write, args=("el-a", "agent-one"), daemon=True),
        threading.Thread(target=write, args=("el-b", "agent-two"), daemon=True),
    ]
    for thread in threads:
        thread.start()
    assert fields["el-a"].inside.wait(5) and fields["el-b"].inside.wait(5), "the writes did not overlap"

    for field in fields.values():
        field.may_finish.set()
    for thread in threads:
        thread.join(5)

    assert outcome["agent-one"]["ok"] is True
    assert outcome["agent-two"]["ok"] is True


def test_reading_a_field_somebody_is_writing_is_not_refused(desktop):
    """Ownership is about writing. Watching a sentence appear stays allowed."""
    built, _, _ = desktop
    holds.acquire("el-a", "agent-one", "typeText")

    assert call(built, "getRevision", clientId="agent-two")["revision"] >= 0
