"""The ceiling follows the file, without a restart.

The consent tests next door prove the ceiling decides correctly, and the
enforcement tests prove the server asks it. What neither proves is that the
ceiling a request meets is the one the user most recently saved. A permissions
page whose checkbox only takes effect after a daemon restart teaches people to
stop trusting the checkbox, so the reload has to be pinned from the request
path — the same seam a real client's call goes through.

The failure directions matter more than the success one: a malformed save must
keep the ceiling it had (falling back to defaults would fail permissive on a
typo), and a deleted file must keep it too (absence after boot is more likely
half a save than a decision).
"""

from __future__ import annotations

import json

import pytest

from desktop_service import server


@pytest.fixture
def rig(tmp_path, monkeypatch):
    """A configured server whose config file is ours, restored afterwards."""
    monkeypatch.setattr(server, "_consent", server._consent)
    monkeypatch.setattr(server, "_audit", server._audit)
    monkeypatch.setattr(server, "_ceiling_watch", server._CeilingWatch())
    path = tmp_path / "config.json"

    def save(scopes):
        path.write_text(json.dumps({"audit": False, "scopes": scopes}))

    save({"operationClasses": ["observe", "edit", "activate"]})
    server.configure(json.loads(path.read_text()), str(path), config_exists=True)
    built = server.build_server(str(tmp_path / "test.sock"))
    return built, path, save


def call(built, method, **params):
    return built._handlers[method](params)


def test_a_saved_edit_takes_effect_on_the_next_request(rig):
    built, _, save = rig
    assert server._consent.ceiling.permits_application("discord")
    save({"operationClasses": ["observe"], "blockedApplications": ["discord"]})
    call(built, "getRevision", clientId="a")
    assert not server._consent.ceiling.permits_application("discord")


def test_a_malformed_save_keeps_the_ceiling_it_had(rig):
    built, path, save = rig
    save({"operationClasses": ["observe"], "blockedApplications": ["discord"]})
    call(built, "getRevision", clientId="a")
    assert not server._consent.ceiling.permits_application("discord")

    path.write_text("{ this is not json")
    call(built, "getRevision", clientId="a")
    assert not server._consent.ceiling.permits_application("discord")


def test_a_fix_after_a_malformed_save_is_picked_up(rig):
    built, path, save = rig
    path.write_text("{ this is not json")
    call(built, "getRevision", clientId="a")
    save({"operationClasses": ["observe"], "blockedApplications": ["discord"]})
    call(built, "getRevision", clientId="a")
    assert not server._consent.ceiling.permits_application("discord")


def test_a_deleted_file_keeps_the_ceiling_it_had(rig):
    built, path, save = rig
    save({"operationClasses": ["observe"], "blockedApplications": ["discord"]})
    call(built, "getRevision", clientId="a")
    path.unlink()
    call(built, "getRevision", clientId="a")
    assert not server._consent.ceiling.permits_application("discord")


def test_an_unchanged_file_rebuilds_nothing(rig):
    built, _, _ = rig
    call(built, "getRevision", clientId="a")
    before = server._consent.ceiling
    call(built, "getRevision", clientId="a")
    assert server._consent.ceiling is before
