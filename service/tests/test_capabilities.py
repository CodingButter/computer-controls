"""Capability report contract tests.

The report's job is honesty: name what this session is, and for everything this
build cannot do, say so with a reason rather than staying quiet about it.
"""

from desktop_service import capabilities


def working_probe():
    return {"available": True, "applicationCount": 12}


def broken_probe():
    return {"available": False, "reason": "the accessibility bus refused the connection"}


def tier(report, tier_id):
    return next(t for t in report["tiers"] if t["id"] == tier_id)


def test_report_names_the_display_server():
    report = capabilities.build_report(working_probe)
    assert report["session"]["displayServer"] in {"x11", "wayland", "unknown"}
    assert report["session"]["desktopEnvironment"]
    assert report["protocolVersion"] == capabilities.PROTOCOL_VERSION


def test_session_token_is_stable_within_a_run_and_present_in_the_report():
    report = capabilities.build_report(working_probe)
    assert report["sessionToken"] == capabilities.session_token()
    assert len(report["sessionToken"]) >= 8


def test_out_of_scope_tiers_are_unavailable_with_a_reason():
    report = capabilities.build_report(working_probe)
    for tier_id in ("app-native", "wayland-portals", "vision", "raw-input"):
        entry = tier(report, tier_id)
        assert entry["available"] is False, f"{tier_id} must not claim availability"
        assert entry["reason"], f"{tier_id} must explain why it is unavailable"


def test_every_tier_is_reported_never_omitted():
    report = capabilities.build_report(working_probe)
    ids = {t["id"] for t in report["tiers"]}
    assert ids == {
        "app-native",
        "accessibility",
        "window-management",
        "wayland-portals",
        "vision",
        "raw-input",
    }


def test_accessibility_availability_is_decided_by_the_probe():
    """The probe is the deciding input — not a setting, not the environment.

    Same environment, two probe results, two answers. That is what makes this a
    probe rather than a guess dressed up as one.
    """
    assert tier(capabilities.build_report(working_probe), "accessibility")["available"] is True

    broken = tier(capabilities.build_report(broken_probe), "accessibility")
    assert broken["available"] is False
    assert "refused the connection" in broken["reason"]


def test_gsetting_is_not_consulted(monkeypatch):
    """A machine where the gsetting reads false still reports the bridge working.

    This machine is exactly that case, which is why the setting is not an input.
    """
    monkeypatch.setenv("GTK_MODULES", "")
    report = capabilities.build_report(working_probe)
    entry = tier(report, "accessibility")
    assert entry["available"] is True
    assert "toolkit-accessibility" in entry["detail"]["note"]


def test_recommended_backends_only_lists_available_tiers():
    report = capabilities.build_report(working_probe)
    available = {t["id"] for t in report["tiers"] if t["available"]}
    assert set(report["recommendedBackends"]) == available
    assert "vision" not in report["recommendedBackends"]


def test_wayland_session_is_reported_honestly(monkeypatch):
    monkeypatch.setenv("XDG_SESSION_TYPE", "wayland")
    monkeypatch.setenv("WAYLAND_DISPLAY", "wayland-0")
    monkeypatch.setenv("DISPLAY", "")
    report = capabilities.build_report(working_probe)
    assert report["session"]["displayServer"] == "wayland"
    # Reported honestly in both directions: the session is Wayland, and this build
    # still cannot drive it.
    assert tier(report, "wayland-portals")["available"] is False
    assert tier(report, "window-management")["available"] is False
    assert "not x11" in tier(report, "window-management")["reason"]
