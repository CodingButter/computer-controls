"""Consent, without a desktop.

The interesting assertions here are the refusals, and in particular the ones
that refuse something the caller is entitled to ask for politely: a client
cannot grant itself past the user's configuration, cannot grant its way out of
an emergency stop, and cannot turn an expired grant into a denial it might
retry forever.
"""

from __future__ import annotations

import pytest

from desktop_service import security
from desktop_service.errors import DesktopError, ErrorCode


class Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def consent(**ceiling) -> security.Consent:
    return security.Consent(security.Ceiling(**ceiling), now=Clock())


def full_ceiling(**kwargs) -> security.Ceiling:
    return security.Ceiling(classes=frozenset(security.OPERATION_CLASSES), **kwargs)


def test_a_fresh_client_may_look_and_nothing_else():
    c = consent()
    assert c.decide(method="listWindows", operation_class="observe", client_id="a").allowed
    assert not c.decide(method="focusWindow", operation_class="activate", client_id="a").allowed


def test_a_grant_may_narrow_within_the_ceiling():
    c = security.Consent(full_ceiling(), now=Clock())
    c.grant("a", classes=["activate", "edit"])
    assert c.decide(method="typeText", operation_class="edit", client_id="a").allowed
    assert not c.decide(method="invokeElement", operation_class="submit", client_id="a").allowed


def test_a_grant_may_not_widen_the_ceiling():
    c = consent(classes=frozenset({"observe", "focus"}))
    with pytest.raises(DesktopError) as raised:
        c.grant("a", classes=["destructive"])
    assert raised.value.code == ErrorCode.PERMISSION_DENIED
    # A denial nobody can act on is a shrug. This one names the config key.
    assert "desktop.scopes" in raised.value.detail["remedy"]


def test_a_denial_says_what_was_needed_and_what_is_held():
    c = security.Consent(full_ceiling(), now=Clock())
    c.grant("a", classes=["edit"])
    decision = c.decide(method="invokeElement", operation_class="submit", client_id="a")
    with pytest.raises(DesktopError) as raised:
        decision.raise_for_denial(c.ceiling, c.grant_of("a").classes)
    assert raised.value.detail["requiredOperationClass"] == "submit"
    assert "edit" in raised.value.detail["grantedOperationClasses"]


def test_observation_survives_having_no_grant_at_all():
    # Every grant carries observe, so a client that asked only for edit does
    # not lose the ability to check whether its edit worked.
    c = security.Consent(full_ceiling(), now=Clock())
    grant = c.grant("a", classes=["edit"])
    assert "observe" in grant.classes


def test_a_blocked_application_is_not_even_observable():
    # The window the user walled off is invisible, not merely unactionable:
    # reading a password manager is the thing being prevented.
    c = security.Consent(full_ceiling(blocked_applications=frozenset({"bitwarden"})), now=Clock())
    c.grant("a", classes=["observe"])
    assert not c.decide(
        method="inspectWindow", operation_class="observe", client_id="a", application="Bitwarden"
    ).allowed


def test_an_allowlist_excludes_everything_it_does_not_name():
    c = security.Consent(full_ceiling(applications=frozenset({"text editor"})), now=Clock())
    c.grant("a", classes=["edit"], applications=["text editor"])
    assert c.decide(
        method="typeText", operation_class="edit", client_id="a", application="gnome Text Editor"
    ).allowed
    assert not c.decide(
        method="typeText", operation_class="edit", client_id="a", application="Discord"
    ).allowed


def test_a_grant_can_be_narrower_than_the_ceiling_by_application():
    c = security.Consent(full_ceiling(), now=Clock())
    c.grant("a", classes=["edit"], applications=["text editor"])
    assert not c.decide(
        method="typeText", operation_class="edit", client_id="a", application="Discord"
    ).allowed


def test_submitting_needs_the_caller_to_have_meant_this_one():
    c = security.Consent(full_ceiling(), now=Clock())
    c.grant("a", classes=["submit"])
    assert not c.decide(method="invokeElement", operation_class="submit", client_id="a").allowed
    assert c.decide(
        method="invokeElement", operation_class="submit", client_id="a", confirmed=True
    ).allowed


def test_editing_does_not_need_confirmation_per_call():
    # Typing a sentence one word at a time would otherwise be twelve consent
    # prompts, and a prompt nobody reads is worse than no prompt.
    c = security.Consent(full_ceiling(), now=Clock())
    c.grant("a", classes=["edit"])
    assert c.decide(method="typeText", operation_class="edit", client_id="a").allowed


def test_a_grant_expires_and_says_so_distinctly():
    clock = Clock()
    c = security.Consent(full_ceiling(), now=clock)
    c.grant("a", classes=["edit"], seconds=60)
    clock.advance(61)
    with pytest.raises(DesktopError) as raised:
        c.decide(method="typeText", operation_class="edit", client_id="a")
    # "Allowed, ask again" is a different instruction from "never allowed".
    assert raised.value.code == ErrorCode.SESSION_EXPIRED


def test_an_expired_grant_still_permits_observation():
    clock = Clock()
    c = security.Consent(full_ceiling(), now=clock)
    c.grant("a", classes=["edit"], seconds=60)
    clock.advance(61)
    assert c.decide(method="listWindows", operation_class="observe", client_id="a").allowed


def test_use_postpones_expiry():
    clock = Clock()
    c = security.Consent(full_ceiling(), now=clock)
    c.grant("a", classes=["edit"], seconds=60)
    clock.advance(30)
    assert c.decide(method="typeText", operation_class="edit", client_id="a").allowed
    clock.advance(30)
    assert c.decide(method="typeText", operation_class="edit", client_id="a").allowed


def test_emergency_stop_revokes_everything_and_keeps_refusing():
    c = security.Consent(full_ceiling(), now=Clock())
    c.grant("a", classes=["submit"])
    assert c.emergency_stop("the user said stop") == 1
    decision = c.decide(
        method="invokeElement", operation_class="submit", client_id="a", confirmed=True
    )
    assert not decision.allowed
    # It must be refused *because of the stop*, not merely because revoking the
    # grant happened to leave nothing behind. Those two produce the same
    # boolean and mean entirely different things to whoever reads the log.
    assert "stop" in decision.reason.lower()
    assert "the user said stop" in decision.reason


def test_the_stop_refuses_even_a_client_holding_a_grant():
    # Revocation and refusal are separate mechanisms on purpose: if a grant
    # survived a stop by any route — a race, a re-grant, a future feature that
    # restores sessions — the stop still has to hold.
    c = security.Consent(full_ceiling(), now=Clock())
    c.emergency_stop()
    c.clear_stop()
    c.grant("a", classes=["submit"])
    c.emergency_stop()
    c._grants["a"] = security.Grant(classes=frozenset({"observe", "submit"}))
    decision = c.decide(
        method="invokeElement", operation_class="submit", client_id="a", confirmed=True
    )
    assert not decision.allowed
    assert "stop" in decision.reason.lower()


def test_a_stopped_service_can_still_be_looked_at():
    # Somebody has to be able to see what state the desktop was left in.
    c = security.Consent(full_ceiling(), now=Clock())
    c.emergency_stop()
    assert c.decide(method="listWindows", operation_class="observe", client_id="a").allowed


def test_a_client_cannot_grant_its_way_out_of_a_stop():
    # A stop a client can lift is a suggestion.
    c = security.Consent(full_ceiling(), now=Clock())
    c.emergency_stop()
    with pytest.raises(DesktopError):
        c.grant("a", classes=["submit"])


def test_clearing_the_stop_is_deliberate_and_does_not_time_out():
    clock = Clock()
    c = security.Consent(full_ceiling(), now=clock)
    c.emergency_stop()
    clock.advance(10_000)
    assert c.stopped
    c.clear_stop()
    c.grant("a", classes=["submit"])
    assert c.decide(
        method="invokeElement", operation_class="submit", client_id="a", confirmed=True
    ).allowed


def test_grants_are_per_client():
    c = security.Consent(full_ceiling(), now=Clock())
    c.grant("a", classes=["submit"])
    assert not c.decide(
        method="invokeElement", operation_class="submit", client_id="b", confirmed=True
    ).allowed


def test_an_unknown_operation_class_is_refused_rather_than_ignored():
    c = security.Consent(full_ceiling(), now=Clock())
    with pytest.raises(DesktopError):
        c.grant("a", classes=["superuser"])


def test_configuration_rejects_a_class_it_does_not_understand():
    # A typo in a config file must not silently produce a narrower ceiling than
    # the user believes they wrote.
    with pytest.raises(ValueError):
        security.Ceiling.from_config({"operationClasses": ["observe", "edti"]})


def test_configuration_defaults_to_read_only():
    ceiling = security.Ceiling.from_config({})
    assert ceiling.classes == security.DEFAULT_CLASSES


def test_every_method_in_the_protocol_declares_a_class_this_module_knows():
    from desktop_service import protocol_generated

    declared = set(protocol_generated.OPERATION_CLASS.values())
    assert declared <= set(security.OPERATION_CLASSES), declared - set(security.OPERATION_CLASSES)


def test_no_method_is_missing_an_operation_class():
    # An unclassified method would be an unguarded one, and it would be
    # unguarded quietly.
    from desktop_service import protocol_generated

    missing = set(protocol_generated.PARAMS_SCHEMA) - set(protocol_generated.OPERATION_CLASS)
    assert missing == set()


def test_a_missing_config_file_is_the_safe_answer_rather_than_an_error(tmp_path):
    from desktop_service import config

    assert config.load(tmp_path / "absent.json") == {}
    assert security.Ceiling.from_config(config.load(tmp_path / "absent.json")).classes == security.DEFAULT_CLASSES


def test_a_malformed_config_is_refused_rather_than_ignored(tmp_path):
    # Falling back to defaults on a trailing comma hands back a service that
    # ignores what it was told — quietly, and in the direction nobody checks.
    from desktop_service import config

    broken = tmp_path / "config.json"
    broken.write_text('{"scopes": {"operationClasses": ["observe",]}}')
    with pytest.raises(ValueError):
        config.load(broken)


def test_the_worked_example_is_a_configuration_this_code_accepts(tmp_path):
    # An example in a docstring that the loader would reject is a support
    # ticket with a delay fuse.
    from desktop_service import config

    ceiling = security.Ceiling.from_config(config.EXAMPLE["scopes"])
    assert "edit" in ceiling.classes
    assert "bitwarden" in ceiling.blocked_applications


def test_a_first_run_is_told_to_write_the_file_not_to_edit_it():
    # The out-of-the-box refusal is the first thing a client author reads, and
    # on a first run the file it names is not there. "Widen the ceiling in this
    # file" sends them looking for a file that does not exist, and the obvious
    # conclusion — wrong path — is the wrong one.
    ceiling = security.Ceiling.from_config(None, "/home/someone/.config/x/config.json", exists=False)
    consent = security.Consent(ceiling)

    with pytest.raises(security.PermissionDenied) as denial:
        consent.enforce(method="focusWindow", operation_class="activate", client_id="new")

    remedy = denial.value.detail["remedy"]
    assert "/home/someone/.config/x/config.json" in remedy
    assert "Create" in remedy
    assert "operationClasses" in remedy, "a reader guessing key names guesses wrong silently"


def test_an_existing_file_is_named_as_something_to_widen():
    ceiling = security.Ceiling.from_config(
        {"operationClasses": ["observe"]}, "/home/someone/config.json", exists=True
    )
    consent = security.Consent(ceiling)

    with pytest.raises(security.PermissionDenied) as denial:
        consent.enforce(method="focusWindow", operation_class="activate", client_id="new")

    remedy = denial.value.detail["remedy"]
    assert "Widen" in remedy and "does not exist" not in remedy
