"""Declared observation interest — who is watching what, by connection.

The module's own contract, tested in isolation from the server: a subscription
is keyed by the transport-minted identity, a declared intent outranks the
recency heuristic, over the ceiling is a refusal that names the ceiling, and
the watch set dies with the connection that declared it.
"""

from __future__ import annotations

import pytest

from desktop_service import subscriptions
from desktop_service.errors import DesktopError, ErrorCode


@pytest.fixture(autouse=True)
def clean():
    subscriptions.clear()
    yield
    subscriptions.clear()


def test_declaring_adds_to_the_watch_set() -> None:
    subscriptions.declare("cl-one", "el-a")
    assert "el-a" in subscriptions.all_ids()


def test_subscribing_twice_is_idempotent_and_does_not_count_twice() -> None:
    subscriptions.declare("cl-one", "el-a")
    subscriptions.declare("cl-one", "el-a")
    assert subscriptions.all_ids() == {"el-a"}


def test_the_watch_set_is_the_union_across_connections() -> None:
    subscriptions.declare("cl-one", "el-a")
    subscriptions.declare("cl-two", "el-b")
    assert subscriptions.all_ids() == {"el-a", "el-b"}


def test_release_reports_whether_anything_was_given_up() -> None:
    subscriptions.declare("cl-one", "el-a")
    assert subscriptions.release("cl-one", "el-a") is True
    assert subscriptions.release("cl-one", "el-a") is False


def test_release_cleans_up_the_connection_entry() -> None:
    subscriptions.declare("cl-one", "el-a")
    subscriptions.release("cl-one", "el-a")
    assert subscriptions.all_ids() == set()


def test_forget_drops_a_connections_subscriptions() -> None:
    subscriptions.declare("cl-one", "el-a")
    subscriptions.declare("cl-two", "el-b")
    subscriptions.forget("cl-one")
    assert subscriptions.all_ids() == {"el-b"}


def test_over_the_ceiling_is_refused_with_the_ceiling_named() -> None:
    for i in range(subscriptions.MAX_SUBSCRIPTIONS_PER_CONNECTION):
        subscriptions.declare("cl-one", f"el-{i}")

    with pytest.raises(DesktopError) as exc_info:
        subscriptions.declare("cl-one", "el-overflow")

    assert exc_info.value.code == ErrorCode.SUBSCRIPTION_LIMIT_REACHED
    assert exc_info.value.detail["ceiling"] == subscriptions.MAX_SUBSCRIPTIONS_PER_CONNECTION


def test_purge_removes_an_element_from_every_connection() -> None:
    subscriptions.declare("cl-one", "el-a")
    subscriptions.declare("cl-two", "el-a")
    subscriptions.purge("el-a")
    assert "el-a" not in subscriptions.all_ids()


def test_has_reports_membership() -> None:
    subscriptions.declare("cl-one", "el-a")
    assert subscriptions.has("cl-one", "el-a") is True
    assert subscriptions.has("cl-one", "el-b") is False
    assert subscriptions.has("cl-two", "el-a") is False


def test_the_ceiling_is_per_connection_not_global() -> None:
    for i in range(subscriptions.MAX_SUBSCRIPTIONS_PER_CONNECTION):
        subscriptions.declare("cl-one", f"el-{i}")
    # A second connection has its own ceiling.
    subscriptions.declare("cl-two", "el-x")
    assert "el-x" in subscriptions.all_ids()
