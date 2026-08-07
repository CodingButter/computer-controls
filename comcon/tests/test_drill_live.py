"""The drill-down against a real application, because the gap it closes is a real one.

A unit test with a synthetic tree would prove the walker walks. What needs proving is
that a live GTK4 application genuinely puts content beyond the protocol's legal depth
from a window root, so that starting a walk elsewhere is a capability rather than a
convenience.
"""

from __future__ import annotations

import pytest

from desktop_service import inspect as inspection
from desktop_service.backends import atspi, loop
from tests.test_inspect_live import live_window  # noqa: F401  (live fixture)

MAX_LEGAL_DEPTH = 12


def flatten(element, depth=0, acc=None):
    acc = acc if acc is not None else []
    acc.append((element, depth))
    for child in element.children:
        flatten(child, depth + 1, acc)
    return acc


def walk_from(root, depth=MAX_LEGAL_DEPTH, max_nodes=1000):
    bounds = inspection.Bounds(depth=depth, max_nodes=max_nodes)
    return loop.call_on_loop(
        lambda: inspection.inspect_tree(
            root, describe=atspi.describe, children=atspi.children_of, bounds=bounds
        ),
        timeout=20.0,
    )


def test_content_below_the_legal_depth_is_reachable_only_by_drilling(live_window) -> None:
    """The window wall is real, and anchoring past it is what gets through it.

    Written against structure rather than against a particular document: the assertion is
    that *something* with text exists below the frontier, not that a specific string
    does. A test that asserted the contents of whatever happens to be open would fail for
    the wrong reason every time the editor did.
    """
    from_window = walk_from(live_window)
    nodes = flatten(from_window.root)
    depths = [depth for _element, depth in nodes]
    assert max(depths) == MAX_LEGAL_DEPTH, (
        "this application must actually reach the depth limit for the test to mean "
        "anything; if it no longer does, the gap being tested has changed"
    )

    frontier = [element for element, depth in nodes if depth == MAX_LEGAL_DEPTH]
    assert frontier, "there must be nodes at the wall to anchor on"

    def text_bearing(result) -> list:
        # Presence of a text-bearing element, not presence of text. An empty document
        # is still a document: this test asks whether the walker can reach the buffer,
        # and asking whether the buffer has anything in it made a human clearing the
        # editor look identical to the drill-down being broken.
        return [
            element
            for element, _depth in flatten(result.root)
            if element.role in atspi.TEXT_VALUE_ROLES
        ]

    reachable_from_window = bool(text_bearing(from_window))
    reachable_by_drilling = False
    absolute_depth = 0
    for anchor_element in frontier:
        anchor_obj = atspi.lookup(anchor_element.id)
        if anchor_obj is None:
            continue
        drilled = walk_from(anchor_obj, depth=MAX_LEGAL_DEPTH, max_nodes=300)
        below = [
            (element, depth)
            for element, depth in flatten(drilled.root)
            if element.role in atspi.TEXT_VALUE_ROLES
        ]
        if below:
            reachable_by_drilling = True
            absolute_depth = MAX_LEGAL_DEPTH + below[0][1]
            break

    if reachable_from_window:
        pytest.skip("this editor's text sits within the legal depth today; nothing to prove")

    assert reachable_by_drilling, (
        "text exists in this window but no legal window inspection reaches it, and "
        "drilling from the frontier did not reach it either — the drill-down is not "
        "doing the one thing it was added for"
    )
    assert absolute_depth > MAX_LEGAL_DEPTH


def test_drilling_keeps_the_same_bounds_it_was_given(live_window) -> None:
    """Deeper access is a change of starting point, never a loosening of limits."""
    from_window = walk_from(live_window)
    anchor = flatten(from_window.root)[-1][0]
    anchor_obj = atspi.lookup(anchor.id)
    if anchor_obj is None:
        pytest.skip("anchor went away between the walk and the drill")

    tight = walk_from(anchor_obj, depth=2, max_nodes=3)
    assert tight.node_count <= 3
    assert max(depth for _element, depth in flatten(tight.root)) <= 2
    if tight.node_count == 3:
        assert tight.truncated, "hitting the budget must be marked, never silent"
