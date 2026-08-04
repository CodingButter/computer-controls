"""Whether enforcement is actually in the path, asked of the server itself.

The consent module is tested on its own next door, and passing there proves it
decides correctly. It does not prove that anything asks it. These tests go
through `build_server`, the same registration seam a real client's call goes
through, because the only interesting failure mode of a permission system is
the method that quietly does not use it.
"""

from __future__ import annotations

import json
import logging

import pytest

from desktop_service import audit, protocol_generated, security, server, state
from desktop_service.errors import DesktopError, ErrorCode, PermissionDenied


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


def test_a_grant_reports_its_own_severity_and_breadth(built):
    # The two numbers a dispatcher needs to size the model it puts behind this
    # scope. Both are facts about the grant, so nothing has to be asked a model
    # to learn them.
    srv, _, _ = built
    granted = call(
        srv,
        "grantScope",
        operationClasses=["observe", "edit"],
        applications=["gnome-text-editor"],
        clientId="scribe",
    )
    assert granted["severity"] == {"rank": 1, "irreversible": False}
    assert granted["breadth"] == {"applications": 1, "anchors": 0, "unbounded": False}


def test_a_grant_that_named_no_application_says_it_is_unbounded(built):
    # The default ceiling names no applications either, so this grant reaches
    # all of them. Zero would read as the narrowest scope in the system.
    srv, _, _ = built
    granted = call(srv, "grantScope", operationClasses=["observe"], clientId="wanderer")
    assert granted["breadth"]["unbounded"] is True


def test_a_wider_grant_reports_a_higher_severity_and_breadth(built):
    # The same client asking for more mid-run: the report moves with it, which
    # is what lets a dispatcher re-select rather than carry on cheaply.
    srv, _, _ = built
    call(srv, "grantScope", operationClasses=["observe"], applications=["chrome"], clientId="scribe")
    wider = call(
        srv,
        "grantScope",
        operationClasses=["observe", "submit"],
        applications=["chrome", "gnome-text-editor", "vesktop"],
        clientId="scribe",
    )
    assert wider["severity"] == {"rank": 3, "irreversible": True}
    assert wider["breadth"]["applications"] == 3


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
    entries = log.tail(10)
    methods = [entry["method"] for entry in entries]
    assert "grantScope" in methods
    # The reason a grant was asked for is the argument that won, and it is the
    # whole point of recording the call: months later the question is *why*.
    grant_record = next(e for e in entries if e["method"] == "grantScope")
    assert grant_record.get("reason") == "typing a reply"


def test_a_narrower_grant_cannot_reach_another_application(built, monkeypatch):
    srv, consent, log = built
    monkeypatch.setattr(server, "_application_of", lambda params: "Discord")
    monkeypatch.setattr(server, "_needs_application", lambda klass: True)
    consent.grant("actor", classes=["edit"], applications=["text editor"])
    with pytest.raises(DesktopError) as raised:
        call(srv, "typeText", elementId="el-1", text="hi", clientId="actor")
    # Out-of-scope and nonexistent are indistinguishable: the denial is
    # disguised as APPLICATION_NOT_FOUND rather than PERMISSION_DENIED, and
    # neither the error nor the audit log names the target.
    assert raised.value.code == ErrorCode.APPLICATION_NOT_FOUND
    assert "Discord" not in str(raised.value)
    denied = next(e for e in log.tail(10) if e.get("decision") == "denied")
    assert not denied.get("application"), "the audit log must not name a disguised target"


def test_a_disguised_refusal_still_tells_the_client_author_what_happened(built, monkeypatch, caplog):
    """The agent is told nothing. The developer is told everything.

    Both halves of the ruling are load-bearing. Disguising the refusal without
    writing the truth anywhere leaves a client author watching an agent report
    that their browser does not exist, with no way to learn that their own
    config is what said so. The service log is the right place because it is
    the one channel with no protocol method behind it: `auditTail` is a tool,
    and a diagnostic there would be the leak the disguise exists to close.
    """
    srv, consent, log_ = built
    monkeypatch.setattr(server, "_application_of", lambda params: "Discord")
    monkeypatch.setattr(server, "_needs_application", lambda klass: True)
    consent.grant("actor", classes=["edit"], applications=["text editor"])

    with caplog.at_level(logging.WARNING), pytest.raises(DesktopError):
        call(srv, "typeText", elementId="el-1", text="hi", clientId="actor")

    diagnostic = "\n".join(record.getMessage() for record in caplog.records)
    assert "Discord" in diagnostic, "the client author was told nothing at all"
    assert "text editor" in diagnostic, "the diagnostic does not say what the grant did cover"
    # And the leak stays closed on the channels the agent can read.
    assert all("Discord" not in str(entry) for entry in log_.tail(10))


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


def test_every_step_a_batch_accepts_is_a_step_the_schema_names():
    # These two drifted once already: the server grew typing into batches and
    # the schema's list of what may appear in one was never widened, so the
    # capability existed in the code and was rejected at the door. A batch step
    # the schema does not name is unreachable; one the server does not know is
    # a crash.
    named = set(
        protocol_generated.PARAMS_SCHEMA["performActions"]["properties"]["actions"]["items"][
            "properties"
        ]["method"]["enum"]
    )
    assert named == set(server._BATCH_METHODS)


def test_a_batch_cannot_reach_an_application_a_direct_call_cannot(monkeypatch):
    # The exploit this closes: a blocklist checked against the batch's own
    # parameters is checked against a call that targets nothing, because the
    # target lives one level down in the steps.
    ceiling = security.Ceiling(
        classes=frozenset({"observe", "activate", "submit"}),
        blocked_applications=frozenset({"a-password-manager"}),
    )
    server._consent = security.Consent(ceiling)
    server._consent.grant("agent", classes=["activate", "submit"])
    monkeypatch.setattr(server, "_application_of", lambda params: (
        "a-password-manager" if params.get("windowId") == "win-blocked" else ""
    ))
    ran: list[str] = []
    monkeypatch.setitem(server._BATCH_METHODS, "focusWindow", lambda params: ran.append("focus"))

    guarded = server._guarded("performActions", server._method_perform_actions)
    with pytest.raises(DesktopError) as raised:
        guarded({
            "clientId": "agent",
            "confirm": True,
            "actions": [{"method": "focusWindow", "params": {"windowId": "win-blocked"}}],
        })
    assert raised.value.code == ErrorCode.APPLICATION_NOT_FOUND
    assert "a-password-manager" not in str(raised.value)
    assert ran == [], "the batch must be refused before any step of it happens"


def test_a_batch_of_permitted_steps_still_runs(monkeypatch):
    ceiling = security.Ceiling(classes=frozenset({"observe", "activate", "submit"}))
    server._consent = security.Consent(ceiling)
    server._consent.grant("agent", classes=["activate", "submit"])
    monkeypatch.setattr(server, "_application_of", lambda params: "some-editor")
    ran: list[str] = []
    monkeypatch.setitem(
        server._BATCH_METHODS, "focusWindow",
        lambda params: (ran.append("focus"), {"actionId": "act-1", "ok": True})[1],
    )

    guarded = server._guarded("performActions", server._method_perform_actions)
    guarded({
        "clientId": "agent",
        "confirm": True,
        "actions": [{"method": "focusWindow", "params": {"windowId": "win-ok"}}],
    })
    assert ran == ["focus"]


def anchored(built, monkeypatch, *, tree: dict[str, tuple[str, ...]], lives=None):
    """A client whose grant hangs on a form, with a tree for the guard to walk.

    The walk itself belongs to the toolkit and is stubbed here for the same
    reason the application lookup is: what these tests are for is whether the
    guard asks, not whether AT-SPI answers.
    """
    srv, consent, log = built
    consent.grant(
        "actor",
        classes=[],
        anchors=[
            security.Anchor("el-form", frozenset({"observe"}), covers_descendants=True),
            security.Anchor("el-message", frozenset({"observe", "edit"})),
        ],
        reason="fill in the message",
    )
    monkeypatch.setattr(
        server, "_ancestry_of", lambda params: tree.get(params.get("elementId"), ())
    )
    if lives is not None:
        monkeypatch.setattr(server, "_anchor_lives", lives)
    return srv, consent, log


_TREE = {
    "el-message": ("el-message", "el-form", "win-mail", "chrome"),
    "el-subject": ("el-subject", "el-form", "win-mail", "chrome"),
    "el-elsewhere": ("el-elsewhere", "win-other", "chrome"),
}


def test_the_guard_asks_where_the_target_is_before_allowing_a_write(built, monkeypatch):
    # The whole amendment in one call: the ancestry is resolved and the nearest
    # anchor over it decides. Without the guard threading it through, this call
    # is refused by a grant that plainly covers the field.
    anchored(built, monkeypatch, tree=_TREE)
    typed: list[str] = []
    guarded = server._guarded("typeText", lambda params: typed.append(params["elementId"]))
    guarded({"clientId": "actor", "elementId": "el-message", "text": "hi"})
    assert typed == ["el-message"]


def test_a_sibling_under_the_wider_anchor_is_still_read_only(built, monkeypatch):
    srv, _, log = anchored(built, monkeypatch, tree=_TREE)
    with pytest.raises(DesktopError) as raised:
        call(srv, "typeText", elementId="el-subject", text="hi", clientId="actor")
    assert raised.value.code == ErrorCode.PERMISSION_DENIED
    denied = next(e for e in log.tail(10) if e.get("decision") == "denied")
    assert denied["method"] == "typeText"


def test_a_target_no_anchor_covers_is_refused(built, monkeypatch):
    srv, _, _ = anchored(built, monkeypatch, tree=_TREE, lives=lambda target: True)
    with pytest.raises(DesktopError) as raised:
        call(srv, "typeText", elementId="el-elsewhere", text="hi", clientId="actor")
    assert raised.value.code == ErrorCode.PERMISSION_DENIED


def test_a_grant_anchored_to_something_gone_fails_as_a_stale_reference(built, monkeypatch):
    """The trap, asked of the server rather than of the consent module.

    The dialog closed. Answering this as a permission problem would send the
    client to `grantScope`, which would issue the same grant onto the same
    absent element, and the loop would close with nothing anywhere saying why.
    """
    srv, _, log = anchored(
        built, monkeypatch, tree=_TREE, lives=lambda target: target != "el-form"
    )
    with pytest.raises(DesktopError) as raised:
        call(srv, "typeText", elementId="el-elsewhere", text="hi", clientId="actor")
    assert raised.value.code == ErrorCode.ELEMENT_REFERENCE_STALE
    assert "el-form" in raised.value.message
    denied = next(e for e in log.tail(10) if e.get("decision") == "denied")
    assert denied["errorCode"] == "ELEMENT_REFERENCE_STALE"


def test_a_target_the_tree_could_not_place_is_refused_rather_than_waved_through(
    built, monkeypatch
):
    """The gap between "no ancestry" and "no place".

    A walk that comes back empty — a window that closed mid-call, a toolkit that
    did not answer in time — is not a call about the desktop. Reading it as one
    would hand it the general hand, which for an anchored grant is the classes
    it holds outside its anchors, and the fastest way to leave an anchored grant
    is to name something the tree cannot find.
    """
    srv, _, _ = anchored(built, monkeypatch, tree={}, lives=lambda target: True)
    with pytest.raises(DesktopError) as raised:
        call(srv, "typeText", elementId="el-message", text="hi", clientId="actor")
    assert raised.value.code == ErrorCode.PERMISSION_DENIED


def test_an_unanchored_grant_never_walks_the_tree(built, monkeypatch):
    """Criterion five, asked where it can actually be broken.

    Anchors are a minority of grants and the walk is a round trip on the single
    thread every client shares. Resolving it for a grant that hung nowhere would
    be a tax every existing caller pays for a feature it is not using.
    """
    srv, consent, _ = built

    def never(params):
        raise AssertionError("the tree was walked for a grant with no anchors")

    monkeypatch.setattr(server, "_ancestry_of", never)
    consent.grant("plain", classes=["edit"])
    typed: list[str] = []
    guarded = server._guarded("typeText", lambda params: typed.append(params["elementId"]))
    guarded({"clientId": "plain", "elementId": "el-message", "text": "hi"})
    assert typed == ["el-message"]


def test_a_batch_step_is_checked_against_its_own_place_in_the_tree(built, monkeypatch):
    # The same exploit the application check closed, one level down: a batch's
    # own parameters name no element, so an anchored grant checked against them
    # would find no ancestry and every step would ride on the batch's answer.
    srv, consent, _ = anchored(built, monkeypatch, tree=_TREE, lives=lambda target: True)
    # A batch is a 'submit' call with no place of its own, so the grant has to
    # hold submit somewhere for it to start at all — and edit only where the
    # task actually types.
    consent.grant(
        "actor",
        classes=[],
        anchors=[
            security.Anchor("el-form", frozenset({"submit"}), covers_descendants=True),
            security.Anchor("el-message", frozenset({"edit", "submit"})),
        ],
    )
    ran: list[str] = []
    monkeypatch.setitem(
        server._BATCH_METHODS, "typeText",
        lambda params: (ran.append("typed"), {"actionId": "act-1", "ok": True})[1],
    )
    guarded = server._guarded("performActions", server._method_perform_actions)
    with pytest.raises(DesktopError):
        guarded({
            "clientId": "actor",
            "confirm": True,
            "actions": [
                {"method": "typeText", "params": {"elementId": "el-message", "text": "hi"}},
                {"method": "typeText", "params": {"elementId": "el-subject", "text": "no"}},
            ],
        })
    assert ran == [], "the batch must be refused before any step of it happens"
    # And the refusal is about the second step, not about the batch having no
    # target of its own: a step the grant does cover still runs.
    guarded({
        "clientId": "actor",
        "confirm": True,
        "actions": [{"method": "typeText", "params": {"elementId": "el-message", "text": "hi"}}],
    })
    assert ran == ["typed"]


def test_a_batch_step_that_names_no_place_is_refused_by_an_anchored_grant(
    built, monkeypatch
):
    """The step whose target is missing must not inherit the batch's answer.

    Every method that may appear in a batch acts on a window or an element, so
    a step naming neither is malformed — and the handler would say so. But it
    is enforced before it is validated, and an anchored grant answering it from
    the hand it holds somewhere else is the widening this whole amendment is
    against.
    """
    srv, consent, _ = anchored(built, monkeypatch, tree=_TREE, lives=lambda target: True)
    consent.grant(
        "actor",
        classes=["submit"],
        anchors=[security.Anchor("el-message", frozenset({"edit", "submit"}))],
    )
    ran: list[str] = []
    monkeypatch.setitem(
        server._BATCH_METHODS, "focusWindow",
        lambda params: (ran.append("focused"), {"actionId": "act-1", "ok": True})[1],
    )
    guarded = server._guarded("performActions", server._method_perform_actions)
    with pytest.raises(DesktopError):
        guarded({
            "clientId": "actor",
            "confirm": True,
            "actions": [{"method": "focusWindow", "params": {}}],
        })
    assert ran == []


@pytest.fixture
def walled(monkeypatch):
    """A desktop with one application the user walled off."""
    server._consent = security.Consent(
        security.Ceiling(
            classes=frozenset({"observe", "activate"}),
            blocked_applications=frozenset({"a-password-manager"}),
        )
    )
    return server._consent


def test_a_blocked_application_is_absent_from_the_window_list(walled, monkeypatch):
    # Absent, not present-and-refused: a refusal confirms the application is
    # running, and its window title is a document name, a contact, a subject
    # line — the thing somebody blocks an application to keep out of a
    # transcript in the first place.
    rows = [
        {"id": "win-1", "applicationName": "a-password-manager", "title": "Vault — personal"},
        {"id": "win-2", "applicationName": "some-editor", "title": "notes"},
    ]
    monkeypatch.setattr(server.loop, "call_on_loop", lambda fn, *a, **k: rows)
    listed = server._method_list_windows({})["windows"]
    assert [row["id"] for row in listed] == ["win-2"]
    assert "Vault — personal" not in json.dumps(listed)


def test_a_blocked_application_does_not_announce_itself_in_a_delta(walled, monkeypatch):
    # Built the way the diff engine builds them: the id is an opaque hash, so
    # a filter keyed on it matches nothing while the summary quotes the name
    # in full. That was the real leak, and it survived a test that put the
    # name in the id field.
    changes = [
        {"kind": "window-opened", "revision": 4, "applicationId": "app-5ba8ad86f3c9",
         "applicationName": "a-password-manager", "summary": "a window appeared — a-password-manager: Vault"},
        {"kind": "focus-changed", "revision": 4, "applicationId": "app-19471371d5a5",
         "applicationName": "some-editor", "summary": "focus moved to some-editor: notes"},
    ]
    monkeypatch.setattr(server, "_snapshot", lambda: None)
    monkeypatch.setattr(
        server._deltas, "since",
        lambda revision, client: {"changes": list(changes), "complete": True, "revision": 4},
    )
    delta = server._method_get_delta_since({"sinceRevision": 0, "clientId": "c"})
    assert [change["applicationName"] for change in delta["changes"]] == ["some-editor"]
    assert "Vault" not in json.dumps(delta)


def test_an_allowlist_does_not_hide_what_it_allows(monkeypatch):
    # The failure this guards against: matching an allowlist entry against
    # every identifying field on a row, so a rule naming an application by
    # name fails against the same row's opaque id and hides it.
    server._consent = security.Consent(
        security.Ceiling(classes=frozenset({"observe"}), applications=frozenset({"some-editor"}))
    )
    rows = [
        {"id": "win-1", "applicationName": "some-editor", "applicationId": "app-9f3c11"},
        {"id": "win-2", "applicationName": "something-else", "applicationId": "app-77aa02"},
    ]
    monkeypatch.setattr(server.loop, "call_on_loop", lambda fn, *a, **k: rows)
    listed = server._method_list_windows({})["windows"]
    assert [row["id"] for row in listed] == ["win-1"]


def test_the_active_window_is_not_named_when_it_is_withheld(walled, monkeypatch):
    # Otherwise "is the password manager in front right now" has an answer.
    facts = state.WindowFacts(
        window_id="win-1", application_id="a-password-manager",
        application_name="a-password-manager", title="Vault", role="frame", active=True,
    )
    snapshot = state.Snapshot(revision=3, windows={"win-1": facts})
    monkeypatch.setattr(server, "_snapshot", lambda: snapshot)
    result = server._method_get_desktop_state({})
    assert result["windows"] == []
    assert result["activeWindowId"] == ""
