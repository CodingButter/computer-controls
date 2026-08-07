"""Five acceptance criteria for element subscriptions, driven through the server.

Each test drives the same handler seam a client's call arrives on. The fixture
monkeypatches the server the way test_contention does: a fake registry, a fake
backend, no real display, no real waiting. What is NOT monkeypatched is the
subscription machinery itself — subscriptions.declare/release/forget/all_ids,
the _observe union, the stale probe, and the delta engine are all the real code.
"""

from __future__ import annotations

from typing import Any

import pytest

from desktop_service import (
    audit,
    security,
    server,
    state,
    subscriptions,
)
from desktop_service.errors import DesktopError, ErrorCode
from desktop_service.registry import ElementReferenceStale


class FakeField:
    def __init__(self, text: str = "") -> None:
        self.text = text
        self.editable = True


@pytest.fixture
def desktop(tmp_path, monkeypatch):
    fields: dict[str, FakeField] = {}

    consent = security.Consent(security.Ceiling(classes=frozenset(security.OPERATION_CLASSES)))
    log = audit.AuditLog(tmp_path / "audit.jsonl")
    monkeypatch.setattr(server, "_consent", consent)
    monkeypatch.setattr(server, "_audit", log)

    # Resolve returns a sentinel object so subscribeElement's resolve-first check passes.
    monkeypatch.setattr(server, "_resolve_element", lambda element_id: fields.setdefault(element_id, FakeField()))

    # call_on_loop runs synchronously in the test thread.
    monkeypatch.setattr(server.loop, "call_on_loop", lambda work, timeout=None: work())

    # No real desktop: list_windows returns empty, sample_values reads from our
    # in-memory fields dict, owners_of returns a fixed owner.
    monkeypatch.setattr(server.atspi, "list_windows", lambda: [])
    monkeypatch.setattr(
        server.atspi,
        "sample_values",
        lambda ids: {eid: f.text for eid, f in fields.items() if eid in ids and f.text},
    )
    monkeypatch.setattr(
        server.atspi,
        "owners_of",
        lambda ids: {eid: ("app-a", "Editor") for eid in ids},
    )

    built = server.build_server(str(tmp_path / "test.sock"))
    yield built, fields

    subscriptions.clear()


def call(built, method, **params):
    return built._handlers[method](params)


# ---------------------------------------------------------------------------
# AC1: An agent can subscribe to an element and receive a signal on its change
#      without holding a call open.
# ---------------------------------------------------------------------------
def test_ac1_subscribed_element_change_reaches_getdeltassince(desktop):
    """A value change on a subscribed element appears in getDeltaSince."""
    built, fields = desktop

    fields["el-a"] = FakeField("initial")
    call(built, "subscribeElement", elementId="el-a", clientId="cl-one")

    # First observe establishes the baseline snapshot.
    server._observe()

    # Change the value and observe again — the diff sees el-a in both snapshots now.
    rev_before = server._registry.revision
    fields["el-a"].text = "changed"

    snapshot, changes = server._observe()

    result = built._handlers["getDeltaSince"]({"sinceRevision": rev_before, "clientId": "cl-one"})
    value_changes = [c for c in result["changes"] if c["kind"] == "element-value-changed"]
    assert len(value_changes) == 1
    assert value_changes[0]["elementId"] == "el-a"


# ---------------------------------------------------------------------------
# AC2: A subscribed element is sampled even when it is not among the recently
#      shown.
# ---------------------------------------------------------------------------
def test_ac2_subscribed_element_outside_recency_is_still_sampled(desktop, monkeypatch):
    """An element subscribed to but not in recent(16) is still in the watch set."""
    built, fields = desktop

    fields["el-a"] = FakeField("subscribed value")
    call(built, "subscribeElement", elementId="el-a", clientId="cl-one")

    # Monkeypatch recent() to return OTHER elements, never el-a — proving
    # the subscription union is what puts el-a in the watch set.
    monkeypatch.setattr(
        server._registry,
        "recent",
        lambda limit, roles=None: [f"el-other-{i}" for i in range(limit)],
    )

    # Verify the union: subscriptions.all_ids() includes el-a even though
    # _registry.recent(16) does not.
    watched = list(
        set(server._registry.recent(server.VALUE_WATCH_LIMIT, roles=server.atspi.TEXT_VALUE_ROLES))
        | subscriptions.all_ids()
    )
    assert "el-a" in watched

    # And _observe samples it (its value appears in the snapshot).
    snapshot, changes = server._observe()
    assert "el-a" in snapshot.values


# ---------------------------------------------------------------------------
# AC3: Subscriptions are released on disconnect, test-asserted the way
#      holds.release_all is.
# ---------------------------------------------------------------------------
def test_ac3_disconnect_releases_subscriptions(desktop):
    """A disconnecting connection's subscriptions are forgotten."""
    built, fields = desktop

    call(built, "subscribeElement", elementId="el-a", clientId="cl-one")
    assert "el-a" in subscriptions.all_ids()

    # Simulate the on_disconnect callback the server wires in build_server.
    built._on_disconnect("cl-one")

    assert "el-a" not in subscriptions.all_ids()


# ---------------------------------------------------------------------------
# AC4: Exceeding the ceiling is refused with the ceiling named, never silently
#      truncated.
# ---------------------------------------------------------------------------
def test_ac4_over_ceiling_is_refused_with_ceiling_named(desktop):
    """The (N+1)th subscription raises SUBSCRIPTION_LIMIT_REACHED with the ceiling."""
    built, fields = desktop

    for i in range(subscriptions.MAX_SUBSCRIPTIONS_PER_CONNECTION):
        call(built, "subscribeElement", elementId=f"el-{i}", clientId="cl-one")

    with pytest.raises(DesktopError) as exc_info:
        call(built, "subscribeElement", elementId="el-overflow", clientId="cl-one")

    assert exc_info.value.code == ErrorCode.SUBSCRIPTION_LIMIT_REACHED
    assert exc_info.value.detail["ceiling"] == subscriptions.MAX_SUBSCRIPTIONS_PER_CONNECTION


# ---------------------------------------------------------------------------
# AC5: An element that goes stale or whose window closes produces a terminal
#      signal, with a test asserting the subscriber is told rather than left
#      listening.
# ---------------------------------------------------------------------------
def test_ac5_stale_element_produces_terminal_signal(desktop, monkeypatch):
    """A subscribed element that goes stale emits element-stale and is purged."""
    built, fields = desktop

    fields["el-a"] = FakeField("initial")
    call(built, "subscribeElement", elementId="el-a", clientId="cl-one")

    # First observe: el-a is present, becomes part of the current snapshot.
    snapshot1, changes1 = server._observe()
    assert "el-a" in snapshot1.values

    # Now the element goes stale: sample_values returns empty for it
    # (field text emptied to simulate the element disappearing from the sample),
    # and the registry resolve raises ElementReferenceStale.
    fields["el-a"].text = ""

    def raise_stale(element_id: str):
        raise ElementReferenceStale(
            element_id=element_id,
            observed_at=1,
            current_revision=server._registry.revision,
            changed={},
        )

    monkeypatch.setattr(server._registry, "resolve", raise_stale)
    monkeypatch.setattr(server.atspi, "lookup", lambda eid: None)

    snapshot2, changes2 = server._observe()

    stale_changes = [c for c in changes2 if c["kind"] == "element-stale"]
    assert len(stale_changes) == 1
    assert stale_changes[0]["elementId"] == "el-a"

    # The subscription is purged — the subscriber is told once, not left listening.
    assert "el-a" not in subscriptions.all_ids()
