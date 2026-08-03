"""Inspection is bounded, and its bounds are honest.

These run against a synthetic tree rather than a live desktop so that the shapes
that matter — deep, wide, and filtered — can be constructed deliberately. The
live behaviour is covered by `test_inspect_live.py`.
"""

from __future__ import annotations

import time

from desktop_service import inspect as inspection
from desktop_service.model import SemanticElement
from desktop_service.registry import Fingerprint


class Node:
    def __init__(self, role: str, name: str = "", children=None):
        self.role = role
        self.name = name
        self.children = children or []
        self.parent: Node | None = None
        for child in self.children:
            child.parent = self


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


def parent_of(node: Node) -> Node | None:
    return node.parent


def chain(depth: int) -> Node:
    """A single branch `depth` levels deep, a button at the bottom."""
    node = Node("push button", "Deep")
    for level in range(depth):
        node = Node("panel", f"level-{depth - level}", [node])
    return Node("frame", "Window", [node])


def walk_all(result) -> list:
    return list(result.root.walk())


def test_depth_limit_is_respected_and_admitted():
    """Stopping on depth is still stopping, and has to read as such.

    This test previously asserted the opposite — that a depth-limited walk
    reports `truncated: false` — which made a tree cut off at the ceiling
    indistinguishable from a tree that ended there. Measured against a live
    Discord that silence hid 923 of 952 elements.
    """
    result = inspection.inspect_tree(
        chain(6), describe=describe, children=children,
        bounds=inspection.Bounds(depth=2, max_nodes=100),
    )
    assert result.node_count == 3  # frame + two panels
    assert result.truncated
    # The marker lands on the node the caller can see and drill from, which is
    # the deepest one returned rather than the root.
    deepest = [e for e in walk_all(result) if e.truncated]
    assert [e.name for e in deepest] == ["level-2"]


def test_a_branch_that_ends_above_the_ceiling_is_not_called_truncated():
    """`truncated` means withheld, never merely deep."""
    result = inspection.inspect_tree(
        chain(2), describe=describe, children=children,
        bounds=inspection.Bounds(depth=9, max_nodes=100),
    )
    assert not result.truncated
    assert not any(e.truncated for e in walk_all(result))


def test_a_leaf_sitting_exactly_on_the_ceiling_is_not_called_truncated():
    """The boundary is where the difference is decided, so test it there.

    Two branches reach the depth limit. One has more below it and one is a leaf
    that simply ends there. Marking both would be the same lie as marking
    neither: it would teach a caller to drill into nodes with nothing under them.
    """
    at_the_line = Node("frame", "Window", [
        Node("panel", "has-more", [Node("panel", "hidden", [Node("push button", "Deeper")])]),
        Node("panel", "ends-here", [Node("push button", "Leaf")]),
    ])
    result = inspection.inspect_tree(
        at_the_line, describe=describe, children=children,
        bounds=inspection.Bounds(depth=2, max_nodes=100),
    )
    marked = {e.name for e in walk_all(result) if e.truncated}
    assert marked == {"hidden"}
    assert result.truncated


def test_every_branch_that_was_cut_says_so_not_just_the_first():
    """Depth truncation must not end the walk, or later branches go unmarked.

    The node budget is global, so exhausting it ends everything. The depth limit
    is per branch. Sharing one flag between them means the first branch to reach
    the ceiling silences every branch measured after it — and those branches are
    already in the returned tree, so the caller sees them listed as if complete.
    """
    twins = Node("frame", "Window", [
        Node("panel", "left", [Node("panel", "left-deep", [Node("push button", "L")])]),
        Node("panel", "right", [Node("panel", "right-deep", [Node("push button", "R")])]),
    ])
    result = inspection.inspect_tree(
        twins, describe=describe, children=children,
        bounds=inspection.Bounds(depth=2, max_nodes=100),
    )
    marked = {e.name for e in walk_all(result) if e.truncated}
    assert marked == {"left-deep", "right-deep"}


def test_one_deep_branch_does_not_end_the_walk_for_its_siblings():
    """Depth is per branch; the node budget is global. Only one of them stops us.

    A frame with one deep branch and two shallow ones: the deep branch is cut
    and says so, and both siblings are still returned in full.
    """
    lopsided = Node("frame", "Window", [
        chain(8),
        Node("push button", "Shallow one"),
        Node("push button", "Shallow two"),
    ])
    result = inspection.inspect_tree(
        lopsided, describe=describe, children=children,
        bounds=inspection.Bounds(depth=3, max_nodes=500),
    )
    names = {e.name for e in walk_all(result)}
    assert {"Shallow one", "Shallow two"} <= names
    assert result.truncated


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
    found = inspection.query(
        tree, describe=describe, children=children, role="push button", limit=5
    )
    assert len(found.matches) == 5
    assert not found.truncated
    assert all(m.role == "push button" for m in found.matches)
    assert len(found.observations) >= 5
    # Fifteen more buttons were never reached: saying so is the difference
    # between "these five" and "the five that exist".
    assert found.more


def test_query_matches_name_case_insensitively_as_a_substring():
    tree = Node("frame", "W", [Node("push button", "Save As…"), Node("push button", "Open")])
    found = inspection.query(tree, describe=describe, children=children, name="save")
    assert [m.name for m in found.matches] == ["Save As…"]
    # The whole window fitted: a caller can trust this is the complete answer.
    assert not found.more


def test_query_search_is_bounded_and_reports_truncation():
    tree = Node("frame", "W", [Node("panel", f"P{i}") for i in range(100)])
    found = inspection.query(
        tree, describe=describe, children=children, role="push button", max_nodes=10
    )
    assert found.matches == []
    assert found.truncated
    assert found.more


# ---------------------------------------------------------------------------
# Neighbourhood expansion (issue #43)
# ---------------------------------------------------------------------------

def test_expansion_defaults_off_is_invisible_to_existing_callers():
    """No expansion params, no change to the result at all."""
    tree = Node("frame", "W", [Node("push button", "B")])
    found = inspection.query(
        tree, describe=describe, children=children, role="push button"
    )
    match = found.matches[0]
    assert match.ancestry == []
    assert match.siblings == []
    assert match.children == []
    assert not found.neighbourhood_truncated


def test_ancestors_returned_nearest_first():
    """The first entry in ancestry is the immediate parent, not the root."""
    tree = chain(3)  # frame → level-3 → level-2 → level-1 → button "Deep"
    found = inspection.query(
        tree, describe=describe, children=children,
        parent_of=parent_of, name="Deep", ancestors=2,
    )
    match = found.matches[0]
    assert [a.name for a in match.ancestry] == ["level-3", "level-2"]


def test_descendants_populate_children_to_depth():
    """descendants=N fills element.children recursively to N levels."""
    tree = Node("frame", "W", [
        Node("panel", "P", [
            Node("push button", "C1"),
            Node("panel", "C2", [
                Node("push button", "GC"),
            ]),
        ]),
    ])
    found = inspection.query(
        tree, describe=describe, children=children,
        parent_of=parent_of, name="P", descendants=2,
    )
    match = found.matches[0]
    child_names = [c.name for c in match.children]
    assert child_names == ["C1", "C2"]
    gc = [c for c in match.children if c.name == "C2"][0]
    assert [c.name for c in gc.children] == ["GC"]


def test_siblings_listed_without_the_match_itself():
    tree = Node("frame", "W", [
        Node("push button", f"B{i}") for i in range(5)
    ])
    found = inspection.query(
        tree, describe=describe, children=children,
        parent_of=parent_of, name="B2", siblings=True,
    )
    match = found.matches[0]
    sib_names = [s.name for s in match.siblings]
    assert "B2" not in sib_names
    assert {"B0", "B1", "B3", "B4"} == set(sib_names)


def test_sibling_cap_is_enforced():
    """A list with 50 siblings must not produce 50 entries."""
    tree = Node("frame", "W", [
        Node("push button", f"B{i}") for i in range(50)
    ])
    found = inspection.query(
        tree, describe=describe, children=children,
        parent_of=parent_of, name="B0", siblings=True,
        max_siblings_per_hit=5,
    )
    match = found.matches[0]
    assert len(match.siblings) <= 5


def test_expand_budget_exhaustion_marks_neighbourhood_truncated():
    tree = chain(5)
    found = inspection.query(
        tree, describe=describe, children=children,
        parent_of=parent_of, name="Deep", ancestors=5,
        max_expand_nodes=1,
    )
    # Only one node could be described before the budget ran out.
    assert found.neighbourhood_truncated


def test_expired_deadline_returns_matches_but_no_expansion():
    tree = chain(3)
    found = inspection.query(
        tree, describe=describe, children=children,
        parent_of=parent_of, name="Deep", ancestors=3,
        deadline=time.monotonic() - 1,
    )
    assert len(found.matches) == 1
    assert found.matches[0].ancestry == []
    assert found.neighbourhood_truncated


def test_parent_of_none_skips_ancestors_but_descendants_still_work():
    tree = Node("frame", "W", [
        Node("panel", "P", [Node("push button", "C")]),
    ])
    found = inspection.query(
        tree, describe=describe, children=children,
        parent_of=None, name="P", ancestors=2, descendants=1,
    )
    match = found.matches[0]
    assert match.ancestry == []
    assert [c.name for c in match.children] == ["C"]


def test_every_expanded_node_is_in_observations():
    """A returned ancestor or sibling id must resolve — it was observed."""
    tree = Node("frame", "W", [
        Node("panel", "Container", [
            Node("push button", "Target"),
            Node("push button", "Neighbour"),
        ]),
    ])
    found = inspection.query(
        tree, describe=describe, children=children,
        parent_of=parent_of, name="Target",
        ancestors=2, siblings=True,
    )
    observed_ids = {obs[0] for obs in found.observations}
    match = found.matches[0]
    for ancestor in match.ancestry:
        assert ancestor.id in observed_ids
    for sib in match.siblings:
        assert sib.id in observed_ids
