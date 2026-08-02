"""The version handshake."""

from __future__ import annotations

import pytest

from desktop_service.errors import DesktopError
from desktop_service.protocol_generated import PROTOCOL_VERSION, SCHEMA_DIGEST
from desktop_service.session import ACTIVE_DEFAULTS, IDLE_DEFAULTS, Session


def test_a_matching_version_is_compatible_with_no_difference():
    result = Session().hello({"protocolVersion": PROTOCOL_VERSION})
    assert result["compatible"] is True
    assert result["versionDifference"] == "none"
    assert result["sessionToken"]


def test_a_minor_difference_is_reported_but_allowed():
    result = Session().hello({"protocolVersion": "1.99"})
    assert result["compatible"] is True
    assert result["versionDifference"] == "minor"


def test_a_major_mismatch_fails_the_call():
    """Fails rather than proceeding hopefully.

    A client speaking 2.0 has different expectations about every message here.
    Answering it at all is worse than refusing.
    """
    with pytest.raises(DesktopError) as caught:
        Session().hello({"protocolVersion": "2.0"})
    assert caught.value.detail["clientProtocolVersion"] == "2.0"
    assert caught.value.detail["compatible"] is False


def test_the_handshake_says_which_schema_the_running_process_was_built_from():
    """So an attaching client can explain a missing method instead of guessing.

    Clients do not start this service, they attach to whichever instance is
    already listening — which is deliberately a long-lived daemon. A daemon that
    booted before a method existed answers `METHOD_NOT_FOUND` for a method the
    client's own generated types promise is there, and nothing else in the
    protocol accounts for the difference. This is how the client finds out.
    """
    result = Session().hello({"protocolVersion": PROTOCOL_VERSION})
    assert result["schemaDigest"] == SCHEMA_DIGEST
    # From the generated module rather than a literal: a digest a test hardcodes
    # is a digest that stops tracking the schema the moment someone edits it.
    assert SCHEMA_DIGEST


def test_every_client_sees_the_same_session_token():
    """One service instance, one session — clients share the element namespace."""
    session = Session()
    first = session.hello({"protocolVersion": PROTOCOL_VERSION})
    second = session.hello({"protocolVersion": PROTOCOL_VERSION})
    assert first["sessionToken"] == second["sessionToken"]


def test_the_session_starts_active():
    assert Session().mode == "active"
    assert Session().timings == ACTIVE_DEFAULTS


def test_going_idle_backs_off_every_timing():
    session = Session()
    result = session.set_observation_mode({"mode": "idle"})
    assert result["observationMode"] == "idle"
    for key, value in IDLE_DEFAULTS.items():
        assert result[key] == value
        assert value > ACTIVE_DEFAULTS[key], f"{key} did not back off"


def test_an_explicit_timing_overrides_its_mode_default():
    session = Session()
    result = session.set_observation_mode({"mode": "active", "debounceMs": 50})
    assert result["debounceMs"] == 50
    # The rest still follow the mode: saying "go active, but debounce faster"
    # should not require restating every interval.
    assert result["ceilingMs"] == ACTIVE_DEFAULTS["ceilingMs"]


def test_returning_to_active_restores_the_active_defaults():
    session = Session()
    session.set_observation_mode({"mode": "idle"})
    result = session.set_observation_mode({"mode": "active"})
    assert result == {"observationMode": "active", **ACTIVE_DEFAULTS}
