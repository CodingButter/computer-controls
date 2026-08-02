"""What one connection is looking at, and what that does and does not change.

Two halves, deliberately. The socket half proves attention is per connection and
dies with it, which is a claim about identity and cannot be made in-process: a
test driving the handlers directly would be testing the `clientId` fallback and
reporting it as the rule. The in-process half proves the filter is in the path of
every method that lists something, which is the failure mode a narrowing feature
actually has — the method nobody remembered to route through the choke point.

The load-bearing test in this file is the one that asks for a blocked application
by name. Attention is a client's own declaration; the ceiling is the user's. If
naming an application could put a row back, the wall would be advisory.
"""

from __future__ import annotations

import json
import socket
import threading

import pytest

from desktop_service import attention, security, server, state
from desktop_service.transport import JsonRpcServer


@pytest.fixture(autouse=True)
def clean_attention():
    attention.clear()
    yield
    attention.clear()


@pytest.fixture()
def open_desktop():
    """No ceiling in the way, so a hidden row is attention's doing and nothing else."""
    previous = server._consent
    server._consent = security.Consent(
        security.Ceiling(classes=frozenset(security.OPERATION_CLASSES))
    )
    yield server._consent
    server._consent = previous


@pytest.fixture()
def walled():
    previous = server._consent
    server._consent = security.Consent(
        security.Ceiling(
            classes=frozenset({"observe"}),
            blocked_applications=frozenset({"a-password-manager"}),
        )
    )
    yield server._consent
    server._consent = previous


WINDOWS = [
    {"id": "win-1", "applicationId": "app-aaa", "applicationName": "some-editor", "title": "notes"},
    {"id": "win-2", "applicationId": "app-bbb", "applicationName": "a-browser", "title": "docs"},
]


def declare(client_id: str, applications=(), depth: str = attention.SURFACE) -> None:
    attention.declare(client_id, applications, depth)


# --- the declaration itself, over a real socket -----------------------------


@pytest.fixture()
def served(tmp_path):
    """A server on a socket, plus a way to ask which attentions it is holding."""
    previous = server._consent
    server._consent = security.Consent(
        security.Ceiling(classes=frozenset(security.OPERATION_CLASSES))
    )
    built = server.build_server(str(tmp_path / "attention.sock"))
    built.start()
    yield built
    built.stop()
    server._consent = previous


class Connection:
    def __init__(self, path: str) -> None:
        self.conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.conn.connect(path)
        self.stream = self.conn.makefile("rwb")
        self._id = 0

    def call(self, method: str, **params) -> dict:
        self._id += 1
        self.stream.write(
            (
                json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params})
                + "\n"
            ).encode()
        )
        self.stream.flush()
        return json.loads(self.stream.readline().decode())

    def close(self) -> None:
        self.stream.close()
        self.conn.close()


def test_a_connection_declares_its_attention_and_is_told_what_it_bought(served, tmp_path):
    client = Connection(served.socket_path)
    try:
        result = client.call("setAttention", applications=["some-editor"], depth="tree")["result"]
        assert result["applications"] == ["some-editor"]
        assert result["depth"] == "tree"
        # Not the unscoped ceiling: naming an application is what pays for depth.
        assert result["maxDepth"] == server.SCOPED_MAX_DEPTH
    finally:
        client.close()


def test_depth_without_a_scope_buys_nothing_and_says_so(served):
    client = Connection(served.socket_path)
    try:
        result = client.call("setAttention", depth="tree")["result"]
        assert result["maxDepth"] == server.MAX_DEPTH
    finally:
        client.close()


def test_two_connections_hold_two_attentions(served):
    """The whole point of keying on the connection rather than on a claimed name."""
    first = Connection(served.socket_path)
    second = Connection(served.socket_path)
    try:
        first.call("setAttention", applications=["some-editor"])
        second.call("setAttention", applications=["a-browser"])
        held = {want.declared for want in list(attention._declared.values())}
        assert held == {("some-editor",), ("a-browser",)}
    finally:
        first.close()
        second.close()


def test_a_second_connection_cannot_claim_the_first_ones_attention(served):
    """A `clientId` in the body is a name the caller wrote for itself."""
    first = Connection(served.socket_path)
    try:
        first.call("setAttention", applications=["some-editor"])
        stolen = Connection(served.socket_path)
        try:
            # Naming somebody else and declaring nothing would, if the claim were
            # believed, widen that connection's view back to the whole desktop.
            stolen.call("setAttention", clientId=next(iter(attention._declared)))
        finally:
            stolen.close()
        assert ("some-editor",) in {want.declared for want in attention._declared.values()}
    finally:
        first.close()


def test_attention_is_forgotten_when_its_connection_ends(served):
    client = Connection(served.socket_path)
    client.call("setAttention", applications=["some-editor"])
    assert attention._declared
    client.close()
    deadline = threading.Event()
    for _ in range(100):
        if not attention._declared:
            break
        deadline.wait(0.02)
    assert not attention._declared, "an attention outlived the connection that declared it"


# --- what the filter does to each method that lists something ---------------


def test_an_undeclared_connection_still_sees_the_whole_desktop(open_desktop, monkeypatch):
    """Criterion four: every client that existed before this feature is unaffected."""
    monkeypatch.setattr(server.loop, "call_on_loop", lambda fn, *a, **k: list(WINDOWS))
    listed = server._method_list_windows({"clientId": "cl-undeclared"})["windows"]
    assert [row["id"] for row in listed] == ["win-1", "win-2"]


def test_a_scoped_connection_sees_only_what_it_named(open_desktop, monkeypatch):
    declare("cl-scoped", ["some-editor"])
    monkeypatch.setattr(server.loop, "call_on_loop", lambda fn, *a, **k: list(WINDOWS))
    listed = server._method_list_windows({"clientId": "cl-scoped"})["windows"]
    assert [row["id"] for row in listed] == ["win-1"]


def test_an_application_may_be_named_by_id_as_well_as_by_name(open_desktop, monkeypatch):
    # A client that listed applications and kept the opaque id should not have to
    # keep the display name as well to be able to say what it is watching.
    declare("cl-scoped", ["app-bbb"])
    monkeypatch.setattr(server.loop, "call_on_loop", lambda fn, *a, **k: list(WINDOWS))
    listed = server._method_list_windows({"clientId": "cl-scoped"})["windows"]
    assert [row["id"] for row in listed] == ["win-2"]


def test_the_application_list_is_narrowed_too(open_desktop, monkeypatch):
    declare("cl-scoped", ["some-editor"])
    rows = [
        {"id": "app-aaa", "name": "some-editor"},
        {"id": "app-bbb", "name": "a-browser"},
    ]
    monkeypatch.setattr(server.loop, "call_on_loop", lambda fn, *a, **k: rows)
    listed = server._method_list_applications({"clientId": "cl-scoped"})["applications"]
    assert [row["id"] for row in listed] == ["app-aaa"]


def test_desktop_state_is_narrowed_and_stops_naming_the_active_window(open_desktop, monkeypatch):
    # The active window is a window like any other: a scoped client being told
    # the id of something it is not shown would be told a row exists after all.
    facts = state.WindowFacts(
        window_id="win-2",
        application_id="app-bbb",
        application_name="a-browser",
        title="docs",
        role="frame",
        active=True,
    )
    other = state.WindowFacts(
        window_id="win-1",
        application_id="app-aaa",
        application_name="some-editor",
        title="notes",
        role="frame",
        active=False,
    )
    declare("cl-scoped", ["some-editor"])
    monkeypatch.setattr(
        server, "_snapshot", lambda: state.Snapshot(revision=3, windows={"win-1": other, "win-2": facts})
    )
    result = server._method_get_desktop_state({"clientId": "cl-scoped"})
    assert [row["windowId"] for row in result["windows"]] == ["win-1"]
    assert result["activeWindowId"] == ""


CHANGES = [
    {
        "kind": "focus-changed",
        "revision": 4,
        "applicationId": "app-bbb",
        "applicationName": "a-browser",
        "summary": "focus moved to a-browser: docs",
    },
    {
        "kind": "element-value-changed",
        "revision": 4,
        "applicationId": "app-aaa",
        "applicationName": "some-editor",
        "elementId": "el-1",
        "summary": "an element's value grew by 4 characters",
    },
]


def stub_deltas(monkeypatch, changes):
    monkeypatch.setattr(server, "_snapshot", lambda: None)
    monkeypatch.setattr(
        server._deltas,
        "since",
        lambda revision, client: {"changes": list(changes), "complete": True, "revision": 4},
    )


def test_a_scoped_client_is_not_woken_by_focus_moving_somewhere_else(open_desktop, monkeypatch):
    """Criterion six, and the reason the feature is worth having at all."""
    declare("cl-scoped", ["some-editor"])
    stub_deltas(monkeypatch, CHANGES)
    delta = server._method_get_delta_since({"sinceRevision": 0, "clientId": "cl-scoped"})
    assert [change["kind"] for change in delta["changes"]] == ["element-value-changed"]
    assert "a-browser" not in json.dumps(delta)


def test_an_undeclared_client_is_told_about_everything(open_desktop, monkeypatch):
    stub_deltas(monkeypatch, CHANGES)
    delta = server._method_get_delta_since({"sinceRevision": 0, "clientId": "cl-undeclared"})
    assert len(delta["changes"]) == 2


def test_a_value_change_names_the_application_that_owns_it(open_desktop):
    # Without this the change above is anonymous, and an anonymous change is
    # either shown to every scoped client or to none of them. Both are wrong.
    before = state.Snapshot(
        revision=1,
        values={"el-1": "hello"},
        owners={"el-1": ("app-aaa", "some-editor")},
    )
    after = state.Snapshot(
        revision=2,
        values={"el-1": "hello there"},
        owners={"el-1": ("app-aaa", "some-editor")},
    )
    [change] = state.diff(before, after)
    assert change["kind"] == "element-value-changed"
    assert change["applicationName"] == "some-editor"
    assert change["applicationId"] == "app-aaa"


def test_a_value_change_whose_owner_vanished_is_still_reported(open_desktop):
    # Cautious, not silent: an element losing its application between two reads
    # must not delete the change, only its attribution.
    before = state.Snapshot(revision=1, values={"el-1": "hello"})
    after = state.Snapshot(revision=2, values={"el-1": "hello there"})
    [change] = state.diff(before, after)
    assert "applicationName" not in change


# --- the wall is not negotiable ---------------------------------------------


def test_attention_cannot_reveal_a_blocked_application(walled, monkeypatch):
    """Criterion five. Attention subtracts; it has no verb for adding."""
    declare("cl-scoped", ["a-password-manager"])
    rows = [
        {"id": "win-9", "applicationName": "a-password-manager", "title": "Vault — personal"},
        {"id": "win-1", "applicationName": "some-editor", "title": "notes"},
    ]
    monkeypatch.setattr(server.loop, "call_on_loop", lambda fn, *a, **k: rows)
    listed = server._method_list_windows({"clientId": "cl-scoped"})["windows"]
    assert listed == []
    assert "Vault — personal" not in json.dumps(listed)


def test_a_blocked_application_stays_out_of_a_scoped_delta(walled, monkeypatch):
    declare("cl-scoped", ["a-password-manager"])
    stub_deltas(
        monkeypatch,
        [
            {
                "kind": "window-opened",
                "revision": 4,
                "applicationId": "app-5ba8ad86f3c9",
                "applicationName": "a-password-manager",
                "summary": "a window appeared — a-password-manager: Vault",
            }
        ],
    )
    delta = server._method_get_delta_since({"sinceRevision": 0, "clientId": "cl-scoped"})
    assert delta["changes"] == []
    assert "Vault" not in json.dumps(delta)


def test_the_ceiling_runs_before_attention_at_the_one_choke_point():
    # Asserted against the code because the ordering is the security property:
    # a `_visible` that filtered by attention first and the ceiling second would
    # pass every test above and still be wrong the day the two disagree.
    import inspect as py_inspect

    source = py_inspect.getsource(server._visible)
    assert "_attended(_withheld(" in source


# --- depth ------------------------------------------------------------------


def test_the_depth_ceiling_lifts_only_for_a_scoped_connection(open_desktop):
    """Criterion three: the budget is measured from what the client is watching."""
    declare("cl-scoped", ["some-editor"], attention.TREE)
    declare("cl-shallow", ["some-editor"], attention.SURFACE)
    declare("cl-greedy", (), attention.TREE)
    assert server._depth_ceiling({"clientId": "cl-scoped"}) == server.SCOPED_MAX_DEPTH
    assert server._depth_ceiling({"clientId": "cl-shallow"}) == server.MAX_DEPTH
    assert server._depth_ceiling({"clientId": "cl-greedy"}) == server.MAX_DEPTH
    assert server._depth_ceiling({"clientId": "cl-undeclared"}) == server.MAX_DEPTH


def test_both_inspection_methods_ask_for_the_same_ceiling():
    # Drilling exists because the cap was measured from the wrong place. If only
    # one of the two methods honoured attention, drilling would still be
    # mandatory and the feature would have bought nothing.
    import inspect as py_inspect

    for method in (server._method_inspect_window, server._method_inspect_element):
        assert "_depth_ceiling(params)" in py_inspect.getsource(method)
