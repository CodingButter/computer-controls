"""Acting on a window must not take focus away from whoever is using the desktop.

This is the property that makes the whole approach better than a second person
remoted into the same machine: two people sharing one cursor take turns, and an
agent working quietly in a background window does not. The user asked whether it
was actually true — a fair question, since an earlier test had in fact stolen his
keyboard — and it turned out nobody had measured it.

Measured here against the display server rather than against our own state
model, because our state model is a thing under test and cannot be its own
witness.

Scope, deliberately narrow: this proves GTK application actions. Text entry,
Chromium-family applications and actions that open dialogs are separate
questions, and they get their own tests rather than this one's optimism.
"""

from __future__ import annotations

import pytest

from desktop_service import server
from desktop_service.backends import x11
from tests.test_inspect_live import live_window  # noqa: F401  (live fixture)

# Actions that change something the application will happily undo or that are
# plainly harmless. Nothing here writes to disk or closes anything.
SAFE_ACTIONS = ("win.reload", "view.select-all", "view.zoom-standard", "win.show-help-overlay")


@pytest.fixture()
def background_window(live_window):  # noqa: F811
    """An unfocused window that exposes an action worth invoking."""
    active = x11.active_xid()
    if active is None:
        pytest.skip("no X11 active window to hold constant")

    for window in server._method_list_windows({})["windows"]:
        if window.get("active"):
            continue
        tree = server._method_inspect_window({"windowId": window["id"], "depth": 1})
        actions = tree["window"]["actions"]
        for candidate in SAFE_ACTIONS:
            if candidate in actions:
                return tree["window"]["id"], candidate, active
    pytest.skip("no unfocused window on this desktop exposes a safe action to invoke")


def test_acting_on_a_background_window_leaves_focus_where_it_was(background_window) -> None:
    element_id, action, before = background_window

    result = server._method_invoke_element(
        {"elementId": element_id, "action": action, "settleMs": 400}
    )
    assert result["ok"] is True, f"the action failed, so this proves nothing: {result}"

    after = x11.active_xid()
    assert after == before, (
        f"invoking {action!r} on a background window moved the focus: "
        f"{before:#x} -> {after:#x}. The single advantage this has over a second "
        "person at the same keyboard is that it does not take the keyboard away."
    )
