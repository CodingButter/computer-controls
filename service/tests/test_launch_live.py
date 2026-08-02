"""Starting an application, and owning the window that appears.

Two things are proven here, and the second is the one worth the trouble.

The first is that a launch works at all: an id from the enumeration goes in, a window
comes out, and `waitFor` is what notices it rather than a sleep long enough to hide a
cold start.

The second is attribution. Every other action is scoped to a window that already exists,
so a launch is the one case where the causal scope can only be known after the fact —
and if it were left empty, the application the agent itself just started would come back
to that same agent as somebody else's news. The delta is queried afterwards from the
launcher's own client id, and it must read `self`.

Run against a real desktop. Skipped where the application under test is not installed,
because a launcher test with nothing to launch is a test that passes by not running.
"""

from __future__ import annotations

import os
import shutil

import pytest

from desktop_service import server
from desktop_service.backends import loop

pytestmark = pytest.mark.skipif(
    not os.environ.get("DISPLAY") and not os.path.isdir("/tmp/.X11-unix"),
    reason="no display server to launch anything onto",
)

# Chosen because it is small, starts fast, holds no state and closes without asking
# whether to save. A launcher test that leaves a document open is a launcher test that
# eventually loses somebody's work.
ENTRY_ID = "org.gnome.Calculator.desktop"
CLIENT = "launch-test"


@pytest.fixture(autouse=True)
def desktop_loop():
    """Every call here reaches the toolkit, and the toolkit has one thread."""
    loop.get_loop().start()


@pytest.fixture()
def calculator():
    if not shutil.which("gnome-calculator"):
        pytest.skip("gnome-calculator is not installed")
    listed = server._method_list_installable_applications({})["applications"]
    if not any(entry["id"] == ENTRY_ID for entry in listed):
        pytest.skip(f"{ENTRY_ID} is not among this desktop's installable applications")
    yield ENTRY_ID
    for window in server._method_list_windows({})["windows"]:
        if "calculator" in window.get("applicationName", "").casefold():
            tree = server._method_inspect_window({"windowId": window["id"], "depth": 1})
            if "window.close" in tree["window"]["actions"]:
                server._method_invoke_element(
                    {"elementId": tree["window"]["id"], "action": "window.close"}
                )


def test_launching_opens_a_window_the_launcher_can_claim(calculator) -> None:
    before = server._method_get_revision({})["revision"]

    result = server._method_launch_application(
        {"applicationEntryId": calculator, "clientId": CLIENT}
    )
    assert result["ok"] is True, f"the launch itself failed: {result}"

    # The launch waits for the window it started, so the window is reported here rather
    # than found afterwards. Waiting again would be the caller asking whether something
    # that has already happened is going to happen: `waitFor` judges openings against a
    # baseline taken when the wait begins, and by then this window is part of it.
    opened = [
        change
        for change in result["observedEffects"]["changes"]
        if change["kind"] == "window-opened"
    ]
    assert opened, f"a successful launch reported no window opening: {result}"

    launched = {change["windowId"] for change in opened}
    delta = server._method_get_delta_since({"sinceRevision": before, "clientId": CLIENT})
    openings = [
        change
        for change in delta["changes"]
        if change["kind"] == "window-opened" and change["windowId"] in launched
    ]
    assert openings, f"the delta engine never saw the window open: {delta}"
    assert all(change.get("attribution") == "self" for change in openings), (
        "the launcher was told the window it opened belongs to somebody else: "
        f"{openings}"
    )


def test_another_client_is_told_who_opened_the_window(calculator) -> None:
    """Self is a relationship, not a property: the same opening is news to everyone else.

    Attribution that read `self` to every client would be worse than none at all — a
    second agent would treat an application it did not start as its own doing.
    """
    before = server._method_get_revision({})["revision"]
    result = server._method_launch_application(
        {"applicationEntryId": calculator, "clientId": CLIENT}
    )
    launched = {
        change["windowId"]
        for change in result["observedEffects"]["changes"]
        if change["kind"] == "window-opened"
    }
    assert launched, f"a successful launch reported no window opening: {result}"

    delta = server._method_get_delta_since(
        {"sinceRevision": before, "clientId": "somebody-else"}
    )
    openings = [
        change
        for change in delta["changes"]
        if change["kind"] == "window-opened" and change["windowId"] in launched
    ]
    assert openings, f"the delta engine never saw the window open: {delta}"
    for change in openings:
        assert change["attribution"] == "external"
        assert change["detail"]["causedByClientId"] == CLIENT


def test_an_id_outside_the_enumeration_is_refused() -> None:
    """The enumeration is the guarantee, so a miss must be a refusal, not a fallback."""
    from desktop_service.errors import DesktopError

    with pytest.raises(DesktopError) as raised:
        server._method_launch_application({"applicationEntryId": "/usr/bin/xterm"})
    assert raised.value.code == "APPLICATION_NOT_FOUND"
