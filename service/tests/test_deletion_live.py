"""A deletion made by somebody else, seen the way a client sees it.

The unit tests prove `_edit_shape` classifies a splice correctly given two strings.
What they cannot prove is that the strings ever arrive: the watcher does not subscribe
to text-change events on purpose — every keystroke would cost a D-Bus round trip to say
something a re-read says better — so a text edit reaches a client only because the
sampling lane re-reads the element it is holding. That chain is the thing under test
here, end to end, against a real editor.

The edit is made through the backend rather than through `editText`, which is the whole
point: a call with no method handler behind it logs no action, so nothing in the session
can claim it. That is what a human deleting text looks like from in here, and the record
has to come back labelled `external` rather than attributed to the agent that happened
to be running at the time.

What a backend call cannot stand in for is the person. It changes the same buffer the
same way, and the sampling lane cannot tell the difference because it re-reads rather
than listening — but "cannot tell the difference" is a claim about this code, argued by
the same code. Only a human at a keyboard settles it, which is why this test does not
close the issue on its own and `scripts/prove-deletion-live.py` exists.

Shape and invariants only. Which element of a text editor holds the buffer is not a
stable fact; that the buffer's loss is reported as a loss, with a count, to a caller who
did nothing, is.
"""

from __future__ import annotations

import contextlib
import os
import time

import pytest

from desktop_service import server
from desktop_service.backends import atspi, loop
from desktop_service.errors import DesktopError
from tests.test_inspect_live import live_window  # noqa: F401  (live fixture)

APP = "gnome-text-editor"
APP_BINARY = "/usr/bin/gnome-text-editor"

pytestmark = pytest.mark.skipif(
    not os.path.exists(APP_BINARY), reason=f"{APP_BINARY} is not installed"
)

#: Short by necessity: a value is sampled up to `MAX_VALUE_CHARS`, and an edit made past
#: that frontier is invisible to the diff for reasons that have nothing to do with
#: deletion. Excising a word from the middle also keeps this a *partial* removal — wiping
#: the field is a `cleared`, which is a different shape and a different claim.
SEED = "the quick brown fox jumps over the lazy dog"
EXCISED = "brown "

#: The plugin polls `getDeltaSince` on a one-second tick. Proving it at any faster
#: cadence would prove something no deployed client does.
POLL_SECONDS = 1.0
POLL_TIMEOUT_SECONDS = 15.0

MAX_LEGAL_DEPTH = 12

#: A password field is a text-value role and would otherwise qualify. It must not: its
#: value is redacted at egress, so it reads back empty whether or not somebody has typed
#: into it, and the "is this document empty" guard below would wave through a field that
#: is anything but. The one role this suite must never seed is the one it cannot see.
SEARCH_ROLES = atspi.TEXT_VALUE_ROLES - {"password text"}


def _walk(node, depth=0):
    yield node, depth
    for child in node.get("children") or ():
        yield from _walk(child, depth + 1)


def _find_text_element(window_id: str) -> str | None:
    """The editor's buffer, found the way a client would have to find it.

    Through the handlers rather than through `inspect_tree` directly, because the walk is
    not the only thing needed: only a handler records what it saw in the registry, and an
    element the registry has never heard of is not among the recent few that get
    re-sampled. Finding it by walking privately would produce a test that inspects an
    element and then watches a different set of them.

    The drill is not optional. This editor puts its buffer below the deepest legal window
    inspection, so a single walk from the frame finds nothing and the frontier has to be
    anchored on — the gap `test_drill_live` exists to document.
    """
    tree = server._method_inspect_window(
        {"windowId": window_id, "depth": MAX_LEGAL_DEPTH, "maxNodes": 1000}
    )
    nodes = list(_walk(tree["window"]))
    for node, _depth in nodes:
        if node["role"] in SEARCH_ROLES:
            return node["id"]

    deepest = max(depth for _node, depth in nodes)
    for node, depth in nodes:
        if depth != deepest:
            continue
        with contextlib.suppress(DesktopError):
            drilled = server._method_inspect_element(
                {"elementId": node["id"], "depth": MAX_LEGAL_DEPTH, "maxNodes": 300}
            )
            for below, _below_depth in _walk(drilled["element"]):
                if below["role"] in SEARCH_ROLES:
                    return below["id"]
    return None


@pytest.fixture()
def buffer(live_window):  # noqa: F811
    """An empty, editable text element, left empty again afterwards.

    Refusing to run against a document that already has something in it is deliberate.
    This suite runs on a live desktop that belongs to someone, the test has to overwrite
    the field to know what it is deleting from, and there is no honest way to put back
    text that is only ever read back truncated. Skipping costs a test run; guessing costs
    somebody their unsaved work.
    """
    windows = server._method_list_windows({})["windows"]
    window = next((w for w in windows if w["applicationName"] == APP), None)
    if window is None:
        pytest.skip(f"{APP} did not report a window through the handler")

    element_id = _find_text_element(window["id"])
    if element_id is None:
        pytest.skip("no text-bearing element was reachable in this window")

    # Resolved on the loop thread, like every handler that touches an element does:
    # AT-SPI answers on the thread its main context was initialised with, and a lookup
    # taken from anywhere else is a race that passes until the day it does not.
    def probe():
        obj = server._resolve_element(element_id)
        return obj, atspi.is_editable(obj), atspi.sample_values([element_id]).get(element_id)

    obj, editable, existing = loop.call_on_loop(probe)
    if not editable:
        pytest.skip("the text element found is not editable")
    if existing:
        pytest.skip("this editor has a document open in it; not overwriting somebody's work")

    yield element_id, obj

    loop.call_on_loop(atspi.set_text_value, obj, "")


def _poll_for_value_change(since_revision: int, element_id: str) -> dict | None:
    """Ask the way the plugin asks, and hold the same cursor while asking.

    The cursor stays where it was rather than advancing with each answer: a caller that
    moved its cursor forward on every poll would consume the change in a delta it was not
    yet looking at it for, and then wait out the timeout for a change that had already
    been handed to it.
    """
    deadline = time.monotonic() + POLL_TIMEOUT_SECONDS
    while True:
        delta = server._method_get_delta_since({"sinceRevision": since_revision})
        for change in delta["changes"]:
            if (
                change["kind"] == "element-value-changed"
                and change.get("elementId") == element_id
            ):
                return change
        if time.monotonic() >= deadline:
            return None
        time.sleep(POLL_SECONDS)


def test_an_unclaimed_partial_deletion_arrives_as_a_deletion(buffer) -> None:
    """The record a client receives says what was lost, how much, and by whom.

    Every step here is through a path that logs nothing: seeding and deleting are backend
    calls with no method handler above them, so no action record covers the revision the
    change lands at. An `external` label is therefore a real finding rather than an
    artefact of the test being careful — there is genuinely nobody to attribute it to.
    """
    element_id, obj = buffer

    loop.call_on_loop(atspi.set_text_value, obj, SEED)
    # The baseline has to be taken after the seed is in place: `diff` only reports an
    # element it saw in both snapshots, so a cursor from before the field had contents
    # would make the first sight of the text an addition rather than a change.
    baseline = server._method_get_delta_since({"sinceRevision": 0})["revision"]

    found = loop.call_on_loop(atspi.find_range, obj, EXCISED)
    assert found is not None, f"the seeded text did not read back with {EXCISED!r} in it"
    start, end = found
    assert loop.call_on_loop(atspi.delete_text, obj, start, end), (
        "the toolkit refused the deletion; nothing downstream of this can be tested"
    )

    change = _poll_for_value_change(baseline, element_id)
    assert change is not None, (
        f"a deletion happened and {POLL_TIMEOUT_SECONDS}s of polling never reported it — "
        "the element is either not being sampled or not being diffed"
    )

    detail = change["detail"]
    assert detail["shape"] == "deleted", (
        f"text was removed and the record calls it {detail['shape']!r}: "
        "a client cannot tell a deletion from an insertion out of this"
    )
    assert detail["charactersRemoved"] == len(EXCISED)
    assert detail["charactersAdded"] == 0
    assert detail["lengthBefore"] == len(SEED)
    assert detail["lengthAfter"] == len(SEED) - len(EXCISED)
    assert detail["lengthAfter"] > 0, "a partial removal, not a cleared field"

    assert change["attribution"] == "external", (
        "nothing in this session made this edit; anything but 'external' is the service "
        "taking credit for a change it did not cause"
    )
    # Both halves are needed, and the second is the load-bearing one. An action taken by
    # *another* client is also labelled `external` to this asker — correctly, since this
    # asker did not do it — but it arrives carrying the action that caused it. "Nobody
    # claims this" is the absence of `causedBy`, not the presence of `external`.
    assert "causedBy" not in detail, (
        f"an edit nothing in this session made came back claimed by {detail.get('causedBy')!r}"
    )
    assert change["summary"], "a change with no summary tells a reader nothing"
