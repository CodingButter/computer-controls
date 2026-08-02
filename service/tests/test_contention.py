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

from desktop_service import audit, holds, presence, security, server, state
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

    # Nobody is at this keyboard, and these fields are in no window a display
    # server has heard of. Both probes are stubbed because a paced write asks
    # them between every two words: unstubbed, two writers racing here make
    # concurrent calls to the real X server and the real registry, and the test
    # measures that machine's mood rather than this rule. It passes every time
    # where there is no display to reach, which is exactly why it has to be said
    # out loud here.
    monkeypatch.setattr(
        server, "_presence", presence.Watch(lambda: 90_000, lambda: "no-such-window")
    )
    monkeypatch.setattr(server, "_display_window_of", lambda element_id: "")

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


# --- claims through the handlers, which is where a client takes one


def test_a_claim_holds_a_field_across_two_separate_calls(desktop):
    """Jamie's rule, at the seam a client uses: claim, work, release.

    Nothing is being written when the second agent is refused — the first is
    between calls, which is exactly the gap an implicit hold leaves open and a
    claim closes.
    """
    built, fields, _ = desktop
    taken = call(built, "claimElement", elementId="el-a", clientId="agent-one",
                 estimatedWorkMs=5_000, reason="drafting a reply")

    assert taken["claim"]["clientId"] == "agent-one"
    assert taken["claim"]["reason"] == "drafting a reply"
    assert 0 < taken["claim"]["expiresInMs"] <= taken["claim"]["leaseMs"]

    call(built, "typeText", elementId="el-a", text="half a thought", clientId="agent-one")

    with pytest.raises(DesktopError) as refused:
        call(built, "typeText", elementId="el-a", text="mine now", clientId="agent-two")
    assert refused.value.code == ErrorCode.ELEMENT_HELD
    assert refused.value.detail["heldBy"] == "agent-one"

    call(built, "typeText", elementId="el-a", text=" and the rest", clientId="agent-one")
    assert fields["el-a"].text == "half a thought and the rest"

    given_back = call(built, "releaseElement", elementId="el-a", clientId="agent-one")
    assert given_back["released"] is True
    assert holds.holder("el-a") is None

    call(built, "typeText", elementId="el-a", text="!", clientId="agent-two")


def test_a_second_agent_cannot_claim_what_is_already_claimed(desktop):
    built, _, _ = desktop
    call(built, "claimElement", elementId="el-a", clientId="agent-one", estimatedWorkMs=5_000)

    with pytest.raises(DesktopError) as refused:
        call(built, "claimElement", elementId="el-a", clientId="agent-two", estimatedWorkMs=5_000)

    assert refused.value.code == ErrorCode.ELEMENT_HELD


def test_a_claim_sized_from_the_text_covers_typing_it(desktop):
    """The lease and the work come from the same arithmetic, so they agree."""
    built, _, _ = desktop
    sentence = "a sentence long enough that a house-number lease would be wrong " * 3

    taken = call(built, "claimElement", elementId="el-a", clientId="agent-one",
                 forText=sentence, wordsPerMinute=70)

    assert taken["claim"]["leaseMs"] > server.cadence.estimate_ms(sentence, 70)


def test_releasing_something_you_do_not_hold_is_not_an_error(desktop):
    """The desired state is 'this client owns nothing here', and it already is."""
    built, _, _ = desktop
    assert call(built, "releaseElement", elementId="el-a", clientId="agent-one")["released"] is False


def test_one_agent_cannot_release_anothers_claim(desktop):
    built, _, _ = desktop
    call(built, "claimElement", elementId="el-a", clientId="agent-one", estimatedWorkMs=5_000)

    assert call(built, "releaseElement", elementId="el-a", clientId="agent-two")["released"] is False
    assert holds.holder("el-a").client_id == "agent-one"


def test_claiming_an_element_that_is_not_there_is_refused_before_it_is_owned(desktop):
    """A lease over a field that does not exist refuses everyone for nothing."""
    built, _, _ = desktop
    with pytest.raises(Exception):
        call(built, "claimElement", elementId="el-nowhere", clientId="agent-one", estimatedWorkMs=1_000)

    assert holds.holder("el-nowhere") is None
