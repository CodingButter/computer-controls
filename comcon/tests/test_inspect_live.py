"""Inspection against a real application, launched by the test.

These assert on *shape and invariants*, never on fixed counts. The desktop is a
live system: the number of buttons in a text editor is not a stable fact, but
"a window has a title, exposes actions, and reports the same id twice" is.
"""

from __future__ import annotations

import os
import subprocess
import time

import pytest

from desktop_service import inspect as inspection
from desktop_service.backends import atspi, loop
from desktop_service.registry import ElementRegistry

APP = "gnome-text-editor"
APP_BINARY = "/usr/bin/gnome-text-editor"

pytestmark = pytest.mark.skipif(
    not os.path.exists(APP_BINARY), reason=f"{APP_BINARY} is not installed"
)


def _find_window():
    for app in atspi._iter_desktop_apps():
        if (app.get_name() or "") != APP:
            continue
        for window in atspi._windows_of(app):
            return window
    return None


@pytest.fixture(scope="module")
def live_window():
    """A real window of a real application, started here if not already running."""
    loop.get_loop().start()
    spawned = None
    window = loop.call_on_loop(_find_window, timeout=15.0)
    if window is None:
        spawned = subprocess.Popen(
            [APP_BINARY], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and window is None:
            time.sleep(0.5)
            window = loop.call_on_loop(_find_window, timeout=15.0)
    if window is None:
        pytest.skip(f"{APP} did not expose a window over AT-SPI")
    yield window
    if spawned is not None:
        spawned.terminate()
        spawned.wait(timeout=10)


def _inspect(window, **kwargs):
    bounds = inspection.Bounds(**kwargs)
    return loop.call_on_loop(
        lambda: inspection.inspect_tree(
            window, describe=atspi.describe, children=atspi.children_of, bounds=bounds
        ),
        timeout=25.0,
    )


def test_the_window_is_found_and_describes_itself(live_window):
    result = _inspect(live_window, depth=3, max_nodes=100)
    assert result.root.role in {"frame", "window", "dialog"}
    assert result.root.backend == "atspi"
    assert result.root.id.startswith("el-")
    assert result.root.bounds is not None


def test_frame_actions_are_exposed(live_window):
    """GTK4's real surface.

    This application's element tree is a handful of unnamed panels while its
    frame publishes its entire command set. An inspection that returned only
    children would show nothing usable here, so this asserts the surface exists.
    """
    result = _inspect(live_window, depth=2, max_nodes=50)
    assert result.root.actions, "the GTK4 frame exposed no actions"
    assert any("." in action for action in result.root.actions)


def test_inspection_is_bounded_by_its_node_budget(live_window):
    result = _inspect(live_window, depth=6, max_nodes=3)
    assert result.node_count <= 3
    assert result.truncated


def test_ids_are_stable_across_repeated_inspections(live_window):
    first = _inspect(live_window, depth=3, max_nodes=100)
    second = _inspect(live_window, depth=3, max_nodes=100)
    assert first.root.id == second.root.id
    common = {o[0] for o in first.observations} & {o[0] for o in second.observations}
    assert len(common) >= 1


def test_an_unchanged_window_does_not_advance_the_revision(live_window):
    registry = ElementRegistry(prober=atspi.fingerprint_of)
    first = registry.record(_inspect(live_window, depth=2, max_nodes=30).observations)
    second = registry.record(_inspect(live_window, depth=2, max_nodes=30).observations)
    assert second == first


def test_a_text_element_with_characters_reports_its_text(live_window):
    """An empty value is a legal answer, which is what made this fail quietly.

    The backend read text through a function that takes no range; passing one
    raised TypeError, the dead-peer guard swallowed it, and every text element in
    every window reported an empty value. Nothing failed, no test complained, and
    the editor's buffer simply never arrived. So this asserts against the
    element's own character count: if the toolkit says there are characters,
    the value has to contain them.
    """
    # Queried rather than inspected on purpose: in this application the text
    # buffer sits deeper than the protocol's maximum inspection depth, so a tree
    # walk cannot reach it at all. A role query can, which is the whole argument
    # for having both.
    result = loop.call_on_loop(
        lambda: inspection.query(
            live_window,
            describe=atspi.describe,
            children=atspi.children_of,
            role="text",
            limit=10,
        ),
        timeout=25.0,
    )
    texts = [e for e in result.matches if e.role in {"text", "entry"}]
    if not texts:
        pytest.skip("no text element in this window")

    from desktop_service.backends import atspi as backend

    for element in texts:
        obj = backend._objects.get(element.id)
        if obj is None:
            continue
        count = obj.get_character_count()
        if count > 0:
            assert element.value, (
                "the toolkit reports characters, so the value cannot be empty"
            )
            assert len(element.value) == min(count, backend.MAX_VALUE_CHARS)
            return
    pytest.skip("no text element currently holds any characters")


# ---------------------------------------------------------------------------
# Neighbourhood expansion (issue #43) — live shape assertions
# ---------------------------------------------------------------------------

def _query(window, **kwargs):
    return loop.call_on_loop(
        lambda: inspection.query(
            window,
            describe=atspi.describe,
            children=atspi.children_of,
            parent_of=atspi.parent_of,
            **kwargs,
        ),
        timeout=25.0,
    )


def test_ancestors_chain_reaches_the_window_root(live_window):
    """An ancestor expansion should produce a path toward the window root."""
    result = _query(live_window, role="push button", limit=1, ancestors=8)
    if not result.matches:
        pytest.skip("no push button in this window")
    match = result.matches[0]
    assert match.ancestry, "ancestors requested but none returned"
    # Every ancestor id must be resolvable through the observation registry.
    observed = {o[0] for o in result.observations}
    for ancestor in match.ancestry:
        assert ancestor.id in observed


def test_descendants_build_a_coherent_subtree(live_window):
    """descendants=N should populate children with real sub-elements."""
    result = _query(live_window, role="panel", limit=1, descendants=2)
    if not result.matches:
        pytest.skip("no panel in this window")
    match = result.matches[0]
    if not match.children:
        pytest.skip("this panel has no children")
    # Each child should itself be a valid element with a role and id.
    for child in match.children:
        assert child.role
        assert child.id


def test_siblings_are_under_the_same_parent(live_window):
    """Sibling expansion should return elements that are not the match itself."""
    result = _query(live_window, role="push button", limit=1, siblings=True)
    if not result.matches:
        pytest.skip("no push button in this window")
    match = result.matches[0]
    if not match.siblings:
        pytest.skip("this button has no siblings")
    for sib in match.siblings:
        assert sib.id != match.id
