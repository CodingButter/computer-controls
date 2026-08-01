"""Discovery against the desktop that is actually running.

These assert invariants, never counts. The number of open applications is a
property of whatever the user happens to have open, and a test that pins it is a
test that fails on Tuesday for no reason.
"""

import pytest

from desktop_service.backends import atspi, loop


@pytest.fixture(scope="module")
def desktop():
    desktop_loop = loop.get_loop()
    desktop_loop.start()
    yield desktop_loop
    desktop_loop.stop()


@pytest.fixture(scope="module")
def applications(desktop):
    return loop.call_on_loop(atspi.list_applications, timeout=30.0)


@pytest.fixture(scope="module")
def windows(desktop):
    return loop.call_on_loop(atspi.list_windows, timeout=30.0)


def test_the_bridge_answers(desktop):
    probe = loop.call_on_loop(atspi.probe_desktop, timeout=20.0)
    assert probe["available"] is True, probe.get("reason")


def test_at_least_one_application_is_returned(applications):
    assert len(applications) >= 1


def test_every_application_has_an_id_and_a_name(applications):
    for app in applications:
        assert app["id"].startswith("app-")
        assert isinstance(app["name"], str)
        assert app["backend"] == "atspi"


def test_application_ids_are_unique(applications):
    ids = [a["id"] for a in applications]
    assert len(ids) == len(set(ids))


def test_at_least_one_window_has_a_title(windows):
    assert any(w["title"].strip() for w in windows), "no titled window on this desktop"


def test_window_ids_are_unique(windows):
    ids = [w["id"] for w in windows]
    assert len(ids) == len(set(ids))


def test_window_ids_are_stable_across_calls(desktop):
    first = loop.call_on_loop(atspi.list_windows, timeout=30.0)
    second = loop.call_on_loop(atspi.list_windows, timeout=30.0)
    common = {w["id"] for w in first} & {w["id"] for w in second}
    assert common, "no window survived two consecutive listings"
    titles_first = {w["id"]: w["title"] for w in first}
    titles_second = {w["id"]: w["title"] for w in second}
    for window_id in common:
        assert titles_first[window_id] == titles_second[window_id]


def test_mutter_frames_are_not_reported_as_user_facing_windows(windows, applications):
    """On X11 mutter publishes decoration frames as its own application.

    They duplicate real client windows — reporting them would show two Discords.
    """
    assert not [w for w in windows if w["applicationName"] in atspi.FRAME_PROVIDER_APPS]
    assert not [a for a in applications if a["name"] in atspi.FRAME_PROVIDER_APPS]


def test_every_window_belongs_to_a_listed_application(windows, applications):
    app_ids = {a["id"] for a in applications}
    for window in windows:
        assert window["applicationId"] in app_ids


def test_only_window_roles_are_reported(windows):
    """Zoom parks stray labels as direct children of the application."""
    for window in windows:
        assert window["role"] in atspi.WINDOW_ROLES


def test_filtering_by_application_narrows_the_result(desktop, applications, windows):
    with_windows = [a for a in applications if a["windowCount"] > 0]
    if not with_windows:
        pytest.skip("no application currently has a window")
    target = with_windows[0]
    filtered = loop.call_on_loop(atspi.list_windows, target["id"], timeout=30.0)
    assert filtered, "filtering returned nothing for an application with windows"
    assert {w["applicationId"] for w in filtered} == {target["id"]}
    assert len(filtered) <= len(windows)


def test_window_count_matches_the_window_listing(applications, windows):
    counted = {}
    for window in windows:
        counted[window["applicationId"]] = counted.get(window["applicationId"], 0) + 1
    for app in applications:
        assert app["windowCount"] == counted.get(app["id"], 0)
