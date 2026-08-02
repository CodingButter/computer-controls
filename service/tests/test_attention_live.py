"""The assumption every stubbed test rests on, checked once against a real desktop.

`_application_of` is monkeypatched in every suite that exercises a rule depending
on it — attention's depth ceiling here, the consent ceiling's allowlist and
blocklist in `test_enforcement`. That is the right way to test those rules: they
are about what happens to an answer, not about how the answer is obtained, and a
portable suite cannot ask a desktop anything.

But it leaves one thing unproven, and it is load-bearing for all of them. Every
stub returns a name in the same vocabulary the rules match against. If the real
resolver returned something else — a window title, a bus name, a process id —
each of those suites would keep passing while the rules they describe silently
matched nothing. A stub is an assumption written down; this file is where the
assumption is checked.

So: take a window the desktop really has, resolve it the way the service does,
and require that the answer is something a declaration could name.
"""

from __future__ import annotations

import pytest

from desktop_service import attention, server
from desktop_service.backends import loop


@pytest.fixture()
def a_real_window():
    #: The loop owns every toolkit call, including the one `_application_of`
    #: makes. Started here rather than assumed, the same way the other live
    #: fixtures do it — a live test that inherits a running loop from whichever
    #: file ran before it passes for a reason that is not about itself.
    loop.get_loop().start()
    windows = server._method_list_windows({})["windows"]
    if not windows:
        pytest.skip("no windows on this desktop to resolve")
    for window in windows:
        if window.get("applicationName"):
            return window
    pytest.skip("no window on this desktop names its application")


def test_a_real_window_resolves_to_the_name_attention_matches_on(a_real_window):
    """The resolved name is in the same vocabulary a client declares in.

    A client declares what it sees in `listWindows` — that is the only list it
    has. If `_application_of` answered in different terms, a declaration copied
    straight out of that list would cover nothing, and the depth lift would be
    unreachable rather than wrong. Both failures are quiet, which is why this
    asserts the round trip rather than the string.
    """
    resolved = server._application_of({"windowId": a_real_window["id"]})

    assert resolved, "the desktop could not name the application of a window it just listed"
    assert resolved != server._UNIDENTIFIED

    declared = attention.declare(
        "cl-live-vocabulary",
        applications=(a_real_window["applicationName"],),
        depth=attention.TREE,
    )
    try:
        assert declared.covers(resolved), (
            f"a client declaring {a_real_window['applicationName']!r} — the name this "
            f"very window reports — does not cover {resolved!r}, so the depth lift "
            f"could never be earned by any walk"
        )
    finally:
        attention.forget("cl-live-vocabulary")


def test_the_deep_budget_is_reachable_on_this_desktop(a_real_window):
    """End to end: a declaration taken from the desktop actually lifts the ceiling.

    The unit tests prove the ceiling function does the right thing with an
    answer. This proves the answer arrives — that a client which declares an
    application it can see, and then walks a window of it, is granted the deep
    budget on a real desktop rather than being demoted by a name mismatch
    nothing would have reported.
    """
    client_id = "cl-live-attention"
    attention.declare(
        client_id,
        applications=(a_real_window["applicationName"],),
        depth=attention.TREE,
    )
    try:
        params = {"clientId": client_id, "windowId": a_real_window["id"]}
        assert server._depth_ceiling(params) == server.SCOPED_MAX_DEPTH
    finally:
        attention.forget(client_id)


def test_a_window_of_another_application_is_still_held_to_the_shallow_ceiling(a_real_window):
    """The fix, against real windows rather than a table.

    Needs two applications on the desktop; skips rather than passing vacuously
    when there is only one, because a test that cannot tell the two ceilings
    apart would report success for the wrong reason.
    """
    windows = server._method_list_windows({})["windows"]
    mine = a_real_window["applicationName"]
    other = next(
        (
            w
            for w in windows
            if w.get("applicationName")
            and mine.casefold() not in w["applicationName"].casefold()
            and w["applicationName"].casefold() not in mine.casefold()
        ),
        None,
    )
    if other is None:
        pytest.skip("only one application on this desktop; nothing to walk out of")

    client_id = "cl-live-attention-2"
    attention.declare(client_id, applications=(mine,), depth=attention.TREE)
    try:
        inside = {"clientId": client_id, "windowId": a_real_window["id"]}
        outside = {"clientId": client_id, "windowId": other["id"]}
        assert server._depth_ceiling(inside) == server.SCOPED_MAX_DEPTH
        assert server._depth_ceiling(outside) == server.MAX_DEPTH
    finally:
        attention.forget(client_id)
