"""The permissions registry: which applications agents may touch.

A hub page lets the user check or uncheck applications. That registry drives
three things: visibility (unchecked apps vanish from listings), denial (targeted
calls against them answer APPLICATION_NOT_FOUND, as though they were not
running), and the doorknob signal (the orb tells the user the real reason).

These tests pin the five service-side behaviours the issue names, plus the
shortcut-curing gate that #115 will rely on. The doorknob-signal test lives on
the client side, where the hub appends the line to the reply.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from desktop_service import attention, security, server
from desktop_service.backends import atspi, x11


@pytest.fixture(autouse=True)
def clean_attention():
    attention.clear()
    yield
    attention.clear()


def full_ceiling() -> security.Ceiling:
    return security.Ceiling(classes=frozenset(security.OPERATION_CLASSES))


ON_THE_BUS = [
    {"id": "app-aaa", "name": "some-editor", "pid": 11},
    {"id": "app-bbb", "name": "a-terminal", "pid": 22},
    {"id": "app-ccc", "name": "google-chrome", "pid": 33},
]
BUS_PIDS = {"app-aaa": 11, "app-bbb": 22, "app-ccc": 33}
TOPLEVELS = [
    x11.X11Window(xid=1, pid=11, title="notes", wm_class="Some-editor"),
    x11.X11Window(xid=2, pid=22, title="bash", wm_class="Some-terminal"),
    x11.X11Window(xid=3, pid=33, title="search", wm_class="Google-chrome"),
]


@pytest.fixture()
def desktop(monkeypatch):
    """A desktop with three readable applications on the accessibility bus."""
    monkeypatch.setattr(atspi, "application_pids", lambda: dict(BUS_PIDS))
    monkeypatch.setattr(atspi, "list_applications", lambda: [dict(row) for row in ON_THE_BUS])
    monkeypatch.setattr(atspi, "applications_absent_from_the_tree", lambda: [])
    monkeypatch.setattr(x11, "toplevels", lambda: list(TOPLEVELS))
    monkeypatch.setattr(atspi, "_process_name", lambda pid: "")
    monkeypatch.setattr(server.loop, "call_on_loop", lambda fn, *a, **k: fn(*a))


@pytest.fixture()
def consent_with_registry(tmp_path):
    """Swap in a Consent whose registry persists to a temp file."""
    registry = security.PermissionRegistry(path=tmp_path / "permissions.json")
    previous = server._consent
    server._consent = security.Consent(full_ceiling(), registry=registry)
    yield server._consent
    server._consent = previous


# ---------------------------------------------------------------------------
# 1. An unchecked application is absent from every listing and tree.
# ---------------------------------------------------------------------------

def test_an_unchecked_application_is_absent_from_every_listing_and_tree(
    desktop, consent_with_registry
):
    """The registry narrows like the ceiling: absent, not refused.

    Once armed and an app is unchecked, it must vanish from listApplications,
    from listWindows, and from invisibleApplications — the same shape as a
    ceiling-blocked app. A refusal would confirm the app is running and leak
    its title; absence leaks nothing.
    """
    registry = consent_with_registry.registry
    # Arm the registry by opening the permissions page — seeds all visible
    # apps as permitted.
    result = server._method_get_application_permissions({"clientId": "hub"})
    assert {a["name"] for a in result["applications"]} == {
        "some-editor", "a-terminal", "google-chrome",
    }

    # Uncheck one.
    consent_with_registry.registry.set_permission("google-chrome", False)

    # It is gone from listApplications.
    listing = server._method_list_applications({"clientId": "agent"})
    names = [row["name"] for row in listing["applications"]]
    assert "google-chrome" not in names
    assert "some-editor" in names

    # It is gone from listWindows too.
    windows = server._method_list_windows({"clientId": "agent"})
    app_names = [w.get("applicationName") for w in windows["windows"]]
    assert "google-chrome" not in app_names

    # A targeted call against it is refused with the disguise.
    from desktop_service.errors import ErrorCode

    consent_with_registry.grant("agent", classes=["observe", "edit"])
    decision = consent_with_registry.decide(
        method="inspectWindow",
        operation_class="observe",
        client_id="agent",
        application="google-chrome",
    )
    assert not decision.allowed
    assert decision.disguised_as == ErrorCode.APPLICATION_NOT_FOUND


# ---------------------------------------------------------------------------
# 2. Checking an application makes it visible without a restart.
# ---------------------------------------------------------------------------

def test_checking_an_application_makes_it_visible_without_a_restart(
    desktop, consent_with_registry
):
    """The registry is live: a checkbox takes effect immediately.

    No daemon restart, no hub restart — set_permission is an in-memory write
    that the next _withheld / decide call observes.
    """
    server._method_get_application_permissions({"clientId": "hub"})
    consent_with_registry.registry.set_permission("google-chrome", False)

    listing = server._method_list_applications({"clientId": "agent"})
    assert "google-chrome" not in [r["name"] for r in listing["applications"]]

    # Check it back — no restart, just the write.
    consent_with_registry.registry.set_permission("google-chrome", True)

    listing = server._method_list_applications({"clientId": "agent"})
    assert "google-chrome" in [r["name"] for r in listing["applications"]]


# ---------------------------------------------------------------------------
# 3. Unchecking an application makes it vanish from agent view.
# ---------------------------------------------------------------------------

def test_unchecking_an_application_makes_it_vanish_from_agent_view(
    desktop, consent_with_registry
):
    """The symmetric direction: a permitted app disappears when unchecked."""
    server._method_get_application_permissions({"clientId": "hub"})

    assert consent_with_registry.registry.permits("some-editor")

    consent_with_registry.registry.set_permission("some-editor", False)
    assert not consent_with_registry.registry.permits("some-editor")

    listing = server._method_list_applications({"clientId": "agent"})
    assert "some-editor" not in [r["name"] for r in listing["applications"]]


# ---------------------------------------------------------------------------
# 4. A newly installed application defaults to unpermitted.
# ---------------------------------------------------------------------------

def test_a_newly_installed_application_defaults_to_unpermitted(
    desktop, consent_with_registry
):
    """The detection path (#115): register() defaults to False.

    When a new Chromium/Electron app is detected at boot or post-install, it
    lands on the page unchecked. The user must opt in before the agent can
    see it.
    """
    server._method_get_application_permissions({"clientId": "hub"})

    # A brand-new app the detection path found.
    consent_with_registry.registry.register("brave-browser")

    assert not consent_with_registry.registry.permits("brave-browser")
    assert consent_with_registry.registry.is_known_but_unpermitted("brave-browser")

    # It does not appear in listings.
    listing = server._method_list_applications({"clientId": "agent"})
    assert "brave-browser" not in [r["name"] for r in listing["applications"]]

    # The user opts in.
    consent_with_registry.registry.set_permission("brave-browser", True)
    assert consent_with_registry.registry.permits("brave-browser")


def test_register_does_not_overwrite_a_user_setting(
    desktop, consent_with_registry
):
    """Detection is idempotent: it never clobbers a choice the user made."""
    server._method_get_application_permissions({"clientId": "hub"})
    consent_with_registry.registry.set_permission("some-editor", False)

    # Detection fires again — the user's uncheck must survive.
    consent_with_registry.registry.register("some-editor")
    assert not consent_with_registry.registry.permits("some-editor")


# ---------------------------------------------------------------------------
# 5. The hub signals no permission yet.
#
#    (The doorknob wrapper itself is a client-side concern; this test pins
#    the daemon-side predicate the hub relies on: is_known_but_unpermitted.)
# ---------------------------------------------------------------------------

def test_the_daemon_can_tell_the_hub_which_apps_are_known_but_unpermitted(
    desktop, consent_with_registry
):
    """is_known_but_unpermitted is the hub's signal source.

    When the hub sees an agent reply naming an app, it cross-references the
    registry. An app on the page but unchecked returns True; an app the user
    permitted returns False; an app never detected returns False (the hub has
    no reason to speak about something it has never seen).
    """
    server._method_get_application_permissions({"clientId": "hub"})
    consent_with_registry.registry.set_permission("google-chrome", False)

    assert consent_with_registry.registry.is_known_but_unpermitted("google-chrome")
    assert not consent_with_registry.registry.is_known_but_unpermitted("some-editor")
    assert not consent_with_registry.registry.is_known_but_unpermitted("never-heard-of-it")


# ---------------------------------------------------------------------------
# 6. No agent-facing API can widen a permission.
# ---------------------------------------------------------------------------

def test_the_registry_methods_are_on_the_socket():
    """The write path exists on the daemon's socket.

    grantScope and emergencyStop set the precedent: client operations registered
    on the daemon, deliberately absent from the plugin's ALL_TOOLS. The registry
    methods follow the same pattern — the method is reachable, but no prompt can
    induce a model to call a tool it was never handed. That the methods are
    absent from the plugin's tool catalogue is pinned by a client-side test.
    """
    base = server.build_server("/tmp/test-permissions.sock")
    assert "getApplicationPermissions" in base._handlers
    assert "setApplicationPermission" in base._handlers


# ---------------------------------------------------------------------------
# 7. Shortcut curing only touches permitted applications.
# ---------------------------------------------------------------------------

def test_shortcut_curing_only_touches_permitted_applications(
    desktop, consent_with_registry
):
    """The #115 contract: curing code calls registry.permits() before writing.

    #115's shortcut curing writes user-scope desktop-file overrides to force
    renderer accessibility. Before it writes, it must check the registry —
    an unpermitted app gets no launcher cured. This test pins the gating
    semantics the curing code will rely on.
    """
    server._method_get_application_permissions({"clientId": "hub"})
    consent_with_registry.registry.register("brave-browser", permitted=False)

    # The gate a curing loop would call.
    def may_cure(app_name: str) -> bool:
        return consent_with_registry.registry.permits(app_name)

    # Permitted apps pass.
    assert may_cure("some-editor")
    assert may_cure("a-terminal")

    # Unpermitted apps are blocked.
    assert not may_cure("brave-browser")
    consent_with_registry.registry.set_permission("google-chrome", False)
    assert not may_cure("google-chrome")

    # The user permits brave — now it may be cured.
    consent_with_registry.registry.set_permission("brave-browser", True)
    assert may_cure("brave-browser")


# ---------------------------------------------------------------------------
# Persistence: the registry survives a restart.
# ---------------------------------------------------------------------------

def test_the_registry_persists_across_restarts(tmp_path, desktop):
    """The permissions file outlives the process that wrote it.

    Arming, checking, and unchecking write to ~/.config/mastracode-desktop/
    permissions.json. A new PermissionRegistry reading the same file picks up
    the armed state and every setting.
    """
    path = tmp_path / "permissions.json"

    first = security.PermissionRegistry(path=path)
    first.arm(["some-editor", "a-terminal"])
    first.set_permission("some-editor", False)
    first.register("brave-browser")

    # A fresh instance — the daemon restarting.
    second = security.PermissionRegistry(path=path)
    assert second.armed
    assert not second.permits("some-editor")
    assert second.permits("a-terminal")
    assert not second.permits("brave-browser")
    # An unknown app is denied by default once armed.
    assert not second.permits("never-detected")


def test_an_unarmed_registry_passes_everything_through(tmp_path):
    """Before the page is opened, the registry is invisible.

    A machine that has never had the permissions page opened must behave
    exactly as it did before the feature existed.
    """
    registry = security.PermissionRegistry(path=tmp_path / "absent.json")
    assert not registry.armed
    assert registry.permits("anything")
    assert registry.permits("google-chrome")
    assert registry.permits("")


def test_per_application_ceiling_denies_even_when_registry_is_unarmed(
    desktop, monkeypatch
):
    """The ceiling's per-application mode is not bypassed by an unarmed registry.

    When the user sets permissionsMode to per-application in their config and has
    not yet opened the permissions page, the registry is unarmed — but the ceiling
    denies everything (empty list + per-application mode). The _withheld fast-path
    must not short-circuit past the ceiling in this state.
    """
    ceiling = security.Ceiling(
        classes=frozenset(security.OPERATION_CLASSES),
        applications=frozenset(),
        permissions_mode=security.PER_APPLICATION_MODE,
    )
    registry = security.PermissionRegistry(path=Path("/dev/null"))
    assert not registry.armed

    previous = server._consent
    server._consent = security.Consent(ceiling, registry=registry)
    try:
        apps = server._method_list_applications({"clientId": "test"})
        assert apps["applications"] == []
    finally:
        server._consent = previous
