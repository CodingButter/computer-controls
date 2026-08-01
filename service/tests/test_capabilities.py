"""Capability report contract tests.

The report's job is honesty: name what this session is, and for everything this
build cannot do, say so with a reason rather than staying quiet about it.
"""

from desktop_service import capabilities, protocol_generated, validate


def working_probe():
    return {"available": True, "applicationCount": 12}


def broken_probe():
    return {"available": False, "reason": "the accessibility bus refused the connection"}


def no_capture():
    return "no xwd on PATH: window capture needs both"


def build(probe, capture_probe=no_capture):
    return capabilities.build_report(
        probe, capture_probe, session_token="tok12345", observation_mode="active"
    )


def tier(report, tier_id):
    return next(t for t in report["tiers"] if t["id"] == tier_id)


def test_report_names_the_display_server():
    report = build(working_probe)
    assert report["session"]["displayServer"] in {"x11", "wayland", "unknown"}
    assert report["session"]["desktopEnvironment"]


def test_the_report_carries_the_one_session_token():
    """One token per service instance, reported here and by the handshake.

    Two tokens in circulation would let a gate assert on a value that no other
    call ever returns, which is a proof that proves nothing.
    """
    assert build(working_probe)["session"]["token"] == "tok12345"


def test_the_report_satisfies_the_frozen_result_schema():
    """The schema is the source of truth, so the live report must satisfy it.

    This is the check that was missing while the report drifted off its own
    contract: the generated result schema existed and nothing ever ran it.
    """
    validate.validate_result("getDesktopCapabilities", build(working_probe))


def test_out_of_scope_tiers_are_unavailable_with_a_reason():
    report = build(working_probe)
    for tier_id in ("app-native", "raw-input"):
        entry = tier(report, tier_id)
        assert entry["available"] is False, f"{tier_id} must not claim availability"
        assert entry["reason"], f"{tier_id} must explain why it is unavailable"


def test_capture_availability_is_decided_by_its_own_probe():
    """The vision tier answers to a probe, exactly as the accessibility tier does.

    Both directions matter. A build with the tools reports the tier working; a build
    without them says which tool is missing rather than claiming the whole idea is out
    of scope, which is what this report said back when it was true.
    """
    unavailable = tier(build(working_probe), "vision")
    assert unavailable["available"] is False
    assert "xwd" in unavailable["reason"]

    working = tier(build(working_probe, lambda: ""), "vision")
    assert working["available"] is True
    assert working["reason"] is None
    assert working["detail"]["windowCapture"] is True


def test_the_report_never_claims_screen_capture():
    """Whole-screen capture is not a missing feature here; it is a refused one.

    A caller addresses a window, so the user's other windows are never in frame. That
    is a privacy claim, and a report that quietly implied otherwise would undermine it.
    """
    detail = tier(build(working_probe, lambda: ""), "vision")["detail"]
    assert detail["screenCapture"] is False
    assert detail["screenCaptureReason"]


def test_every_tier_is_reported_never_omitted():
    report = build(working_probe)
    ids = {t["id"] for t in report["tiers"]}
    assert ids == set(protocol_generated.CAPABILITY_TIERS)


def test_accessibility_availability_is_decided_by_the_probe():
    """The probe is the deciding input — not a setting, not the environment.

    Same environment, two probe results, two answers. That is what makes this a
    probe rather than a guess dressed up as one.
    """
    assert tier(build(working_probe), "accessibility")["available"] is True

    broken = tier(build(broken_probe), "accessibility")
    assert broken["available"] is False
    assert "refused the connection" in broken["reason"]


def test_gsetting_is_not_consulted(monkeypatch):
    """A machine where the gsetting reads false still reports the bridge working.

    This machine is exactly that case, which is why the setting is not an input.
    """
    monkeypatch.setenv("GTK_MODULES", "")
    report = build(working_probe)
    entry = tier(report, "accessibility")
    assert entry["available"] is True
    assert "toolkit-accessibility" in entry["detail"]["note"]


def test_recommended_backends_only_lists_available_tiers():
    report = build(working_probe)
    available = {t["id"] for t in report["tiers"] if t["available"]}
    assert set(report["recommendedBackends"]) == available
    assert "vision" not in report["recommendedBackends"]


def test_wayland_session_is_reported_honestly(monkeypatch):
    monkeypatch.setenv("XDG_SESSION_TYPE", "wayland")
    monkeypatch.setenv("WAYLAND_DISPLAY", "wayland-0")
    monkeypatch.setenv("DISPLAY", "")
    report = build(working_probe)
    assert report["session"]["displayServer"] == "wayland"
    # Reported honestly in both directions: the session is Wayland, and this build
    # still cannot drive it.
    compositor = tier(report, "compositor")
    assert compositor["available"] is False
    assert "wayland" in compositor["reason"]
    assert compositor["detail"]["waylandPortals"] is False
