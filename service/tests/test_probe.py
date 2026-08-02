"""The probe measures, and an application that answers nothing is a measurement.

These tests never touch the accessibility bus. The probe's job is to survive
applications that behave badly, and the applications that behave badly are not
reliably installed — so the misbehaviour is supplied here directly, which is both
faster and more thorough than hoping Zoom is running.
"""

from __future__ import annotations

import pytest

from desktop_service import probe


class FakeNode:
    """An accessible that answers exactly as much as it is told to."""

    def __init__(self, role="filler", name="", children=None, actions=(), raises=False):
        self.role = role
        self._name = name
        self._children = children
        self.actions = list(actions)
        self.raises = raises

    def get_name(self):
        return self._name

    def get_process_id(self):
        return 4242


@pytest.fixture
def fake_backend(monkeypatch):
    """Route every backend call the probe makes at the fakes in each test."""

    state: dict = {"app": None, "windows": [], "interfaces": [], "collection": False}

    def children_of(node):
        # None is the failure the real Chrome produced at planning time: a node
        # that has children and declines to list them.
        return node._children

    monkeypatch.setattr(probe.backend, "find_application", lambda app_id: state["app"])
    monkeypatch.setattr(probe.backend, "windows_of_application", lambda app_id: state["windows"])
    monkeypatch.setattr(probe.backend, "interfaces_of", lambda obj: state["interfaces"])
    monkeypatch.setattr(probe.backend, "collection_answers", lambda obj: state["collection"])
    monkeypatch.setattr(probe.backend, "toolkit_of", lambda obj: ("GTK", "4.14"))
    monkeypatch.setattr(probe.backend, "role_of", lambda obj: obj.role)
    monkeypatch.setattr(probe.backend, "actions_of", lambda obj: obj.actions)
    monkeypatch.setattr(probe.backend, "children_of", children_of)
    monkeypatch.setattr(probe.backend, "_safe", lambda fn, default=None: fn())
    return state


def test_an_application_not_on_the_bus_is_none_rather_than_an_empty_probe(fake_backend):
    """Absent and silent are different findings, so they get different answers."""
    fake_backend["app"] = None
    assert probe.probe_application("app-gone") is None


def test_interfaces_depth_and_action_counts_are_reported(fake_backend):
    leaf = FakeNode(role="push button", children=[])
    row = FakeNode(role="panel", children=[leaf])
    window = FakeNode(role="frame", name="Files", children=[row], actions=["win.reload", "win.close"])
    fake_backend.update(
        app=FakeNode(role="application", name="Nautilus"),
        windows=[window],
        interfaces=["Accessible", "Component"],
    )

    result = probe.probe_application("app-1").to_json()

    assert result["interfaces"] == ["Accessible", "Component"]
    assert result["windowCount"] == 1
    assert result["reachableDepth"] == 2
    assert result["nodeCount"] == 3
    assert result["frameActionCount"] == 2
    assert result["frameActions"] == ["win.reload", "win.close"]
    assert result["toolkit"] == "GTK"


def test_an_application_that_exposes_almost_nothing_still_produces_a_row(fake_backend):
    """The Zoom case: an application node, no windows, nothing to walk.

    This is the result that matters most. A probe that raised here would leave
    the compatibility matrix describing only the applications that cooperate,
    which is the matrix nobody needs.
    """
    fake_backend.update(app=FakeNode(name="zoom"), windows=[], interfaces=["Accessible"])

    result = probe.probe_application("app-quiet").to_json()

    assert result["windowCount"] == 0
    assert result["nodeCount"] == 0
    assert result["frameActionCount"] == 0
    assert any("no windows" in note for note in result["notes"])


def test_a_node_that_declines_to_list_children_is_recorded_not_raised(fake_backend):
    """Chrome's frames returned `None` children at planning time.

    `None` is not an empty list: one means "I have no children", the other means
    "I will not tell you". The probe has to distinguish them, because the second
    is the symptom that the whole toolkit-coverage phase exists to chase.
    """
    secretive = FakeNode(role="document web", children=None)
    window = FakeNode(role="frame", children=[secretive])
    fake_backend.update(app=FakeNode(name="Chrome"), windows=[window], interfaces=["Accessible"])

    result = probe.probe_application("app-chrome").to_json()

    assert result["nodeCount"] == 2
    assert any("document web" in note for note in result["notes"])


def test_advertising_collection_is_not_the_same_as_answering_with_it(fake_backend):
    fake_backend.update(
        app=FakeNode(name="Chrome"),
        windows=[],
        interfaces=["Accessible", "Collection"],
        collection=False,
    )

    result = probe.probe_application("app-chrome").to_json()

    assert result["collectionAdvertised"] is True
    assert result["collectionWorks"] is False


def test_a_deep_tree_stops_at_the_bound_and_says_so(fake_backend):
    node = FakeNode(role="panel", children=[])
    for _ in range(probe.MAX_PROBE_DEPTH + 5):
        node = FakeNode(role="panel", children=[node])
    fake_backend.update(app=FakeNode(name="deep"), windows=[node], interfaces=["Accessible"])

    result = probe.probe_application("app-deep").to_json()

    assert result["depthLimited"] is True
    assert result["reachableDepth"] == probe.MAX_PROBE_DEPTH


def test_a_wide_tree_stops_at_the_node_bound_and_says_so(fake_backend):
    children = [FakeNode(role="push button", children=[]) for _ in range(probe.MAX_PROBE_NODES + 10)]
    window = FakeNode(role="frame", children=children)
    fake_backend.update(app=FakeNode(name="wide"), windows=[window], interfaces=["Accessible"])

    result = probe.probe_application("app-wide").to_json()

    assert result["nodeLimited"] is True
    assert result["nodeCount"] <= probe.MAX_PROBE_NODES


def test_editable_fields_are_counted_so_the_matrix_can_say_where_typing_is_possible(fake_backend):
    entry = FakeNode(role="entry", children=[])
    label = FakeNode(role="label", children=[])
    window = FakeNode(role="frame", children=[entry, label])
    fake_backend.update(app=FakeNode(name="form"), windows=[window], interfaces=["Accessible"])

    assert probe.probe_application("app-form").to_json()["editableFields"] == 1
