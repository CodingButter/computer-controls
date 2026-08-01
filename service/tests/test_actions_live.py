"""Acting on a real application, through the same path a client uses.

These go through the server's method handlers rather than the backend, because what
is worth proving is the handler's promises: that a result names the tier that
answered, that a refusal carries the actions that do exist, and that effects come
back attributed to a revision range without the caller re-inspecting anything.

Shape and invariants only. How many actions a text editor exposes is not a stable
fact; that it exposes some, and reports honestly about invoking one, is.
"""

from __future__ import annotations

import os

import pytest

from desktop_service import server
from desktop_service.errors import DesktopError, ErrorCode
from tests.test_inspect_live import live_window  # noqa: F401  (live fixture)

APP_BINARY = "/usr/bin/gnome-text-editor"

pytestmark = pytest.mark.skipif(
    not os.path.exists(APP_BINARY), reason=f"{APP_BINARY} is not installed"
)


@pytest.fixture()
def editor(live_window):  # noqa: F811
    """The editor's window id and frame element id, as a client would hold them."""
    windows = server._method_list_windows({})["windows"]
    window = next(w for w in windows if w["applicationName"] == "gnome-text-editor")
    tree = server._method_inspect_window({"windowId": window["id"], "depth": 1})
    return window["id"], tree["window"]["id"], tree["window"]["actions"]


def test_focus_names_the_tier_that_answered(editor) -> None:
    """Which backend did it is part of the answer, not an implementation detail.

    Accessibility is tried first and the compositor is the fallback. Either may win on
    a given desktop — this box's toolkits never report a window as active, so the
    fallback is load-bearing here — but the result has to say which, and a fallback
    that was tried and failed has to be named rather than hidden behind a plain
    success.
    """
    window_id, _, _ = editor
    result = server._method_focus_window({"windowId": window_id})

    assert result["ok"] is True
    assert result["backend"] in {"accessibility", "compositor"}
    assert result["backend"] not in result["fallbacksUsed"]
    assert result["durationMs"] >= 0


def test_an_unsupported_action_is_refused_with_the_ones_that_exist(editor) -> None:
    """A refusal that does not say what *is* available costs another round trip.

    The caller has already asked the question this answers.
    """
    _, frame_id, real_actions = editor

    with pytest.raises(DesktopError) as raised:
        server._method_invoke_element(
            {"elementId": frame_id, "action": "not-a-real-action"}
        )

    assert raised.value.code == ErrorCode.ACTION_NOT_SUPPORTED
    offered = raised.value.detail["availableActions"]
    assert offered, "a refusal with an empty action list tells the caller nothing"
    assert set(offered) == set(real_actions)


@pytest.fixture()
def focus_restored():
    """Put focus back where it was.

    This suite runs against a live desktop that belongs to someone. A test that
    steals focus and keeps it is a test that will be deleted by an annoyed human,
    which is a worse outcome than not having written it.
    """
    before = next(
        (w["id"] for w in server._method_list_windows({})["windows"] if w["active"]),
        None,
    )
    yield
    if before is not None:
        server._method_focus_window({"windowId": before})


def test_a_focus_change_comes_back_as_an_effect(editor, focus_restored) -> None:
    """The point of the acting layer: the caller is told what happened.

    An API that returned only `{"ok": true}` would force a re-inspection after every
    action just to learn whether anything moved, which is most of the cost of driving
    a desktop. Focus is used here because it is the one effect guaranteed to be
    visible to the accessibility layer — a preference toggle can change the screen
    while changing nothing any backend can observe.
    """
    window_id, _, _ = editor
    others = [
        w["id"]
        for w in server._method_list_windows({})["windows"]
        if w["id"] != window_id and w["title"]
    ]
    if not others:
        pytest.skip("no second window to move focus away to")

    server._method_focus_window({"windowId": others[0]})
    result = server._method_focus_window({"windowId": window_id})

    effects = result["observedEffects"]
    assert effects["toRevision"] >= effects["fromRevision"]
    assert effects["partial"] is False
    assert effects["settledMs"] >= 0

    moved = [c for c in effects["changes"] if c["kind"] == "focus-changed"]
    assert moved, f"focus moved but no effect said so: {effects['changes']}"
    assert moved[0]["windowId"] == window_id
    assert moved[0]["summary"]


def test_an_action_records_the_revision_span_it_occupied(editor) -> None:
    """Phase 5 reads these spans to tell news from consequence.

    The span is stamped before dispatch, so a toolkit that reacts synchronously
    cannot produce effects at a revision the record fails to cover — those effects
    would later be reported to the agent as somebody else's doing.
    """
    _, frame_id, real_actions = editor
    if "settings.show-line-numbers" not in real_actions:
        pytest.skip("editor does not expose the line-number toggle")

    result = server._method_invoke_element(
        {"elementId": frame_id, "action": "settings.show-line-numbers"}
    )
    # Leave the desktop as it was found.
    server._method_invoke_element(
        {"elementId": frame_id, "action": "settings.show-line-numbers"}
    )

    assert result["ok"] is True
    assert result["actionId"].startswith("act-")

    # Queried the way the delta engine will query it: given a revision, which
    # actions were in flight across it?
    effects = result["observedEffects"]
    responsible = server._action_log.covering(effects["fromRevision"])
    assert result["actionId"] in {record.action_id for record in responsible}
    assert all(
        record.covers(effects["toRevision"])
        for record in responsible
        if record.action_id == result["actionId"]
    )
