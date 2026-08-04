"""Two readings of an empty application list, chosen by the user's file.

Open mode is the historical reading: nothing named means nothing withheld.
Per-application mode is the checkbox reading the permissions page needs:
nothing named means nothing permitted, and an application installed five
minutes ago arrives unpermitted rather than pre-approved. The dangerous
failure is a misread mode — "per-application" quietly read as "open" would
permit everything the user was trying to fence — so the unknown-mode refusal
is pinned as hard as the behaviors.
"""

from __future__ import annotations

import pytest

from desktop_service import security


def ceiling(**scopes) -> security.Ceiling:
    return security.Ceiling.from_config(
        {"operationClasses": ["observe"], **scopes}, "/tmp/config.json", exists=True
    )


def test_open_mode_with_an_empty_list_permits_everything_not_blocked():
    c = ceiling(permissionsMode="open")
    assert c.permits_application("discord")


def test_per_application_mode_with_an_empty_list_permits_nothing():
    c = ceiling(permissionsMode="per-application")
    assert not c.permits_application("discord")


def test_per_application_mode_permits_exactly_what_is_named():
    c = ceiling(permissionsMode="per-application", applications=["discord"])
    assert c.permits_application("discord")
    assert not c.permits_application("slack")


def test_the_blocklist_still_wins_in_per_application_mode():
    c = ceiling(
        permissionsMode="per-application",
        applications=["discord"],
        blockedApplications=["discord"],
    )
    assert not c.permits_application("discord")


def test_a_weakly_identified_row_gets_no_benefit_of_the_doubt():
    c = ceiling(permissionsMode="per-application")
    assert not c.permits_weakly_identified_application("discord")


def test_an_action_against_the_desktop_itself_is_not_an_application():
    # An empty name is a desktop-level action; the class rule still applies
    # to it, and the per-application list was never about it.
    c = ceiling(permissionsMode="per-application")
    assert c.permits_application("")


def test_an_unknown_mode_is_refused_rather_than_read_as_open():
    with pytest.raises(ValueError, match="permissionsMode"):
        ceiling(permissionsMode="checkboxes")


def test_the_mode_defaults_to_open_when_the_file_does_not_name_one():
    c = ceiling()
    assert c.permissions_mode == security.OPEN_MODE
    assert c.permits_application("discord")


def test_an_empty_list_in_per_application_mode_is_not_unbounded():
    c = ceiling(permissionsMode="per-application")
    grant = security.Grant(classes=frozenset({"observe"}))
    assert security.breadth_of(grant, c)["unbounded"] is False


def test_an_empty_list_in_open_mode_is_unbounded():
    c = ceiling(permissionsMode="open")
    grant = security.Grant(classes=frozenset({"observe"}))
    assert security.breadth_of(grant, c)["unbounded"] is True
