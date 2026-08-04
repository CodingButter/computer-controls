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


def test_a_shell_session_describes_the_desktop_it_drives_not_itself(monkeypatch):
    """A daemon started from a terminal must not report a terminal.

    This service is started from an SSH shell, a tmux pane or a systemd unit as
    a matter of course, and every one of those inherits `XDG_SESSION_TYPE=tty`
    with no desktop named at all. The display was already discovered rather than
    inherited; the session description now follows it, or the report would
    describe a machine with no desktop while successfully driving one.
    """

    for name in ("XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DISPLAY", "WAYLAND_DISPLAY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("XDG_SESSION_TYPE", "tty")

    report = capabilities.build_report(
        working_probe,
        no_capture,
        session_token="tok12345",
        observation_mode="active",
        discover_session=lambda: {
            "XDG_CURRENT_DESKTOP": "ubuntu:GNOME",
            "XDG_SESSION_TYPE": "x11",
            "DISPLAY": ":1",
        },
    )

    session = report["session"]
    assert session["desktopEnvironment"] == "ubuntu:GNOME"
    assert session["displayServer"] == "x11"
    assert session["compositor"] == "mutter"
    assert session["display"] == ":1"
    # Said out loud, because a borrowed answer and an inherited one are not
    # equally trustworthy and the caller is entitled to tell them apart.
    assert "borrowed" in session["compositorSource"]


def test_our_own_environment_outranks_the_discovered_one(monkeypatch):
    """A caller who set DISPLAY deliberately is not to be second-guessed."""

    monkeypatch.setenv("DISPLAY", ":7")
    monkeypatch.setenv("XDG_CURRENT_DESKTOP", "KDE")

    report = capabilities.build_report(
        working_probe,
        no_capture,
        session_token="tok12345",
        observation_mode="active",
        discover_session=lambda: {"XDG_CURRENT_DESKTOP": "ubuntu:GNOME", "DISPLAY": ":1"},
    )

    assert report["session"]["display"] == ":7"
    assert report["session"]["compositor"] == "kwin"


def test_no_graphical_session_is_an_answer_not_a_guess(monkeypatch):
    """An empty discovery leaves the report honest about knowing nothing."""

    for name in ("XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DISPLAY", "WAYLAND_DISPLAY"):
        monkeypatch.delenv(name, raising=False)

    report = capabilities.build_report(
        working_probe,
        no_capture,
        session_token="tok12345",
        observation_mode="active",
        discover_session=dict,
    )

    assert report["session"]["desktopEnvironment"] == "unknown"
    assert report["session"]["displayServer"] == "unknown"
    assert "borrowed" not in report["session"]["compositorSource"]


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


def test_the_capability_report_names_the_keystroke_tier(monkeypatch):
    """A client that reads only the report must be able to find the keystroke tier.

    The report used to be silent about it: `typeKeystrokes` shipped, went through
    the consent ceiling and the holds registry like every other write, and no tier,
    no detail and no reason string in this document mentioned it. Silence is the
    one thing this report is not allowed to be, because the whole contract is that
    a caller can tell "this desktop cannot" from "this build does not".

    Availability answers to the tier's real dependencies — the accessibility bus
    and an X11 session — and says which one is missing when one is.
    """
    monkeypatch.setenv("DISPLAY", ":1")
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)

    detail = tier(build(working_probe), "accessibility")["detail"]
    assert detail["keystrokes"] is True
    assert detail["keystrokesReason"] is None
    assert "typeKeystrokes" in detail["keystrokesNote"]


def test_a_session_that_cannot_synthesize_says_which_dependency_is_missing(monkeypatch):
    """Unavailable is an answer with a cause, and the cause has to be the real one.

    Both halves are checked, because the failure this replaces named dependencies
    — `/dev/uinput`, `xdotool` — that nothing in this build has ever used, on a
    desktop where typing worked fine.
    """
    monkeypatch.setenv("XDG_SESSION_TYPE", "wayland")
    monkeypatch.setenv("WAYLAND_DISPLAY", "wayland-0")
    monkeypatch.setenv("DISPLAY", "")

    on_wayland = tier(build(working_probe), "accessibility")["detail"]
    assert on_wayland["keystrokes"] is False
    assert "X11" in on_wayland["keystrokesReason"]
    assert "uinput" not in on_wayland["keystrokesReason"]
    # Named even where it cannot run: a caller on Wayland still learns the tier
    # exists, which is what tells them the report is describing this session
    # rather than this build.
    assert "typeKeystrokes" in on_wayland["keystrokesNote"]

    monkeypatch.setenv("DISPLAY", ":1")
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    no_bus = tier(build(broken_probe), "accessibility")["detail"]
    assert no_bus["keystrokes"] is False
    # The bus probe's own words, so the tier and the tier it rides on cannot
    # disagree about why.
    assert "refused the connection" in no_bus["keystrokesReason"]


def test_raw_input_refusal_does_not_deny_the_keystroke_tier():
    """Refusing the driver must not read as refusing the tier.

    These are two different objects that both involve synthetic keys. One types at
    whatever holds focus and is refused permanently; the other is addressed to a
    named element and shipped. The report has to carry both, and the refusal has
    to point at the thing that exists instead of implying nothing does.
    """
    report = build(working_probe)
    raw_input = tier(report, "raw-input")
    keystrokes = tier(report, "accessibility")["detail"]

    assert raw_input["available"] is False
    assert "typeKeystrokes" in raw_input["reason"]
    # The old reason listed tools it never used. Availability here does not turn
    # on what is installed, and saying so kept a reader looking for the wrong
    # evidence.
    assert "uinput" not in raw_input["reason"]
    assert "xdotool" not in raw_input["reason"]

    for value in (keystrokes["keystrokesReason"], keystrokes["keystrokesNote"]):
        assert "out of scope" not in (value or "")


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
