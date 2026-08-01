"""Inspection is bounded, and its bounds are honest.

These run against a synthetic tree rather than a live desktop so that the shapes
that matter — deep, wide, and filtered — can be constructed deliberately. The
live behaviour is covered by `test_inspect_live.py`.
"""

from __future__ import annotations

from desktop_service import inspect as inspection
from desktop_service.model import SemanticElement
from desktop_service.registry import Fingerprint


class Node:
    def __init__(self, role: str, name: str = "", children=None):
        self.role = role
        self.name = name
        self.children = children or []


def describe(node: Node, index: int, parent_digest: str):
    element = SemanticElement(
        id=f"{node.role}:{node.name}:{index}:{parent_digest[:6]}",
        backend="test",
        role=node.role,
        name=node.name,
    )
    fingerprint = Fingerprint(node.role, node.name, index, parent_digest)
    return element, fingerprint, {"id": element.id}


def children(node: Node) -> list[Node]:
    return node.children


def chain(depth: int) -> Node:
    """A single branch `depth` levels deep, a button at the bottom."""
    node = Node("push button", "Deep")
    for level in range(depth):
        node = Node("panel", f"level-{depth - level}", [node])
    return Node("frame", "Window", [node])


def walk_all(result) -> list:
    return list(result.root.walk())


def test_depth_limit_is_respected():
    result = inspection.inspect_tree(
        chain(6), describe=describe, children=children,
        bounds=inspection.Bounds(depth=2, max_nodes=100),
    )
    assert result.node_count == 3  # frame + two panels
    assert not result.truncated


def test_node_budget_truncates_and_says_so():
    wide = Node("frame", "Window", [Node("push button", f"B{i}") for i in range(50)])
    result = inspection.inspect_tree(
        wide, describe=describe, children=children,
        bounds=inspection.Bounds(depth=3, max_nodes=10),
    )
    assert result.truncated
    assert result.node_count == 10
    assert result.root.truncated
    assert result.root.to_json()["truncated"] is True


def test_an_untruncated_tree_carries_no_marker():
    small = Node("frame", "Window", [Node("push button", "Only")])
    result = inspection.inspect_tree(
        small, describe=describe, children=children,
        bounds=inspection.Bounds(depth=3, max_nodes=100),
    )
    assert not result.truncated
    assert "truncated" not in result.root.to_json()


def test_role_filter_shapes_the_result_without_pruning_the_walk():
    """The bug this test exists for.

    On GTK4 every control sits under several unnamed panels. If a role filter
    pruned traversal instead of output, a query for buttons would walk into a
    panel, decide it is not a button, and never reach the buttons inside it —
    returning nothing while the window is full of them.
    """
    buried = Node(
        "frame", "Window",
        [Node("panel", "", [Node("panel", "", [Node("push button", "Save")])])],
    )
    result = inspection.inspect_tree(
        buried, describe=describe, children=children,
        bounds=inspection.Bounds(depth=4, max_nodes=100, include_roles=frozenset({"push button"})),
    )
    roles = [e.role for e in walk_all(result)]
    assert "push button" in roles
    assert "panel" not in roles
    # Everything walked is still registered, filtered out of the result or not:
    # the caller was not shown the panels, but the walk knows they exist.
    assert result.node_count == 4


def test_breadth_first_keeps_the_whole_window_in_view_when_the_budget_runs_out():
    """A cut-off result should be a shallow map, not one deep tunnel."""
    wide_and_deep = Node(
        "frame", "Window",
        [Node("panel", f"P{i}", [chain(5)]) for i in range(8)],
    )
    result = inspection.inspect_tree(
        wide_and_deep, describe=describe, children=children,
        bounds=inspection.Bounds(depth=8, max_nodes=6),
    )
    top_level_names = [c.name for c in result.root.children]
    assert top_level_names == ["P0", "P1", "P2", "P3", "P4"]
    assert all(not child.children for child in result.root.children)


def test_exclude_roles_removes_matching_nodes():
    tree = Node("frame", "W", [Node("panel", "keep"), Node("filler", "drop")])
    result = inspection.inspect_tree(
        tree, describe=describe, children=children,
        bounds=inspection.Bounds(depth=2, max_nodes=50, exclude_roles=frozenset({"filler"})),
    )
    assert [c.role for c in result.root.children] == ["panel"]


def test_query_returns_a_flat_list_bounded_by_limit():
    tree = Node("frame", "W", [Node("push button", f"B{i}") for i in range(20)])
    matches, observations, truncated = inspection.query(
        tree, describe=describe, children=children, role="push button", limit=5
    )
    assert len(matches) == 5
    assert not truncated
    assert all(m.role == "push button" for m in matches)
    assert len(observations) >= 5


def test_query_matches_name_case_insensitively_as_a_substring():
    tree = Node("frame", "W", [Node("push button", "Save As…"), Node("push button", "Open")])
    matches, _obs, _t = inspection.query(
        tree, describe=describe, children=children, name="save"
    )
    assert [m.name for m in matches] == ["Save As…"]


def test_query_search_is_bounded_and_reports_truncation():
    tree = Node("frame", "W", [Node("panel", f"P{i}") for i in range(100)])
    matches, _obs, truncated = inspection.query(
        tree, describe=describe, children=children, role="push button", max_nodes=10
    )
    assert matches == []
    assert truncated
