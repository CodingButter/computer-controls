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


class TestPermissionsPerApplication:
    """The shape a real task needs: read here, send there, and never the reverse.

    Take the notes out of an editor and send them from a browser. Sending is the
    one irreversible act in that sentence and it belongs to exactly one of those
    two applications. A grant that names a class set and a list of applications
    cannot say so, and hands the editor a permission the task never asked for.
    """

    def consent(self):
        return security.Consent(
            security.Ceiling(classes=frozenset({"observe", "edit", "activate", "submit"}))
        )

    def dispatch(self, consent):
        return consent.grant(
            "the-facebook-agent",
            classes=["observe"],
            per_application={
                "gnome-text-editor": ["observe"],
                "chrome": ["observe", "edit", "submit"],
            },
            reason="take the notes from the editor and send them from the browser",
        )

    def test_it_may_send_from_the_application_the_task_sends_from(self):
        consent = self.consent()
        self.dispatch(consent)
        decision = consent.decide(
            method="invokeElement",
            operation_class="submit",
            client_id="the-facebook-agent",
            application="chrome",
            confirmed=True,
        )
        assert decision.allowed

    def test_it_may_not_send_from_the_application_it_only_reads(self):
        """The bug this whole class exists for."""
        consent = self.consent()
        self.dispatch(consent)
        decision = consent.decide(
            method="invokeElement",
            operation_class="submit",
            client_id="the-facebook-agent",
            application="gnome-text-editor",
            confirmed=True,
        )
        assert not decision.allowed
        assert "gnome-text-editor" in decision.reason

    def test_it_may_not_type_into_the_application_it_only_reads(self):
        consent = self.consent()
        self.dispatch(consent)
        decision = consent.decide(
            method="typeText",
            operation_class="edit",
            client_id="the-facebook-agent",
            application="gnome-text-editor",
        )
        assert not decision.allowed

    def test_it_may_read_both(self):
        consent = self.consent()
        self.dispatch(consent)
        for application in ("gnome-text-editor", "chrome"):
            assert consent.decide(
                method="getElement",
                operation_class="observe",
                client_id="the-facebook-agent",
                application=application,
            ).allowed

    def test_an_application_the_task_never_mentioned_is_outside_the_grant(self):
        """Naming applications individually makes the unnamed ones refusals."""
        consent = self.consent()
        self.dispatch(consent)
        decision = consent.decide(
            method="getElement",
            operation_class="observe",
            client_id="the-facebook-agent",
            application="vesktop",
        )
        assert not decision.allowed

    def test_a_per_application_entry_cannot_reach_past_the_ceiling(self):
        """Otherwise it would be a side door rather than a narrowing device."""
        consent = security.Consent(security.Ceiling(classes=frozenset({"observe", "edit"})))
        with pytest.raises(security.ScopeError):
            consent.grant(
                "sneaky",
                classes=["observe"],
                per_application={"chrome": ["submit"]},
            )

    def test_the_reason_it_was_granted_is_kept(self):
        """A manager's justification, readable months later in the audit log."""
        consent = self.consent()
        grant = self.dispatch(consent)
        assert "send them from the browser" in grant.reason

    def test_the_old_shape_still_means_what_it_meant(self):
        """Existing callers grant one hand across a list of applications."""
        consent = self.consent()
        consent.grant("plain", classes=["observe", "edit"], applications=["chrome"])
        assert consent.decide(
            method="typeText", operation_class="edit", client_id="plain", application="chrome"
        ).allowed
        assert not consent.decide(
            method="typeText", operation_class="edit", client_id="plain", application="vesktop"
        ).allowed

    def test_a_grant_built_directly_still_refuses_what_it_did_not_name(self):
        """The rule has to live in the grant, not only in how grants are issued.

        `grant()` folds the per-application names into the application list, so
        the two mechanisms agree and either one would refuse an unnamed
        application. That agreement is exactly what hides a broken rule — a
        grant assembled any other way has only this one.
        """
        grant = security.Grant(
            classes=frozenset({"observe", "submit"}),
            per_application={"chrome": frozenset({"observe"})},
        )
        assert grant.hand_in("chrome") == frozenset({"observe"})
        assert grant.hand_in("vesktop") is None

    def test_naming_a_blocked_application_per_application_is_refused_when_asked_for(self):
        """At the moment of asking, not only at the moment of using.

        Using it would be refused anyway — the ceiling is checked on every call.
        But a grant that appears to have been issued and then refuses everything
        it covers is a grant somebody debugs for an hour.
        """
        consent = security.Consent(
            security.Ceiling(
                classes=frozenset({"observe", "edit", "submit"}),
                blocked_applications=frozenset({"keepassxc"}),
            )
        )
        with pytest.raises(security.ScopeError):
            consent.grant(
                "hopeful",
                classes=["observe"],
                per_application={"keepassxc": ["observe", "edit"]},
            )


class TestAnchors:
    """A permission hung on a place in the tree rather than on an application.

    The task is "fill in this one field and send the form". Expressed against an
    application it becomes "edit anything in the browser", which is a boundary
    around the wrong thing: every other field on the page, and every other page,
    is inside it. The anchors here say the narrow thing instead, and the
    assertions that matter are the ones proving the narrow statement survives
    contact with a wider one sitting above it.
    """

    #: A form, inside a window, inside an application — nearest first, which is
    #: the order the walk out of the tree produces and the order the rule reads.
    FIELD = ("el-message", "el-compose-form", "win-mail", "chrome")
    SIBLING = ("el-subject", "el-compose-form", "win-mail", "chrome")
    ELSEWHERE = ("el-search", "win-browser", "chrome")

    def consent(self) -> security.Consent:
        return security.Consent(full_ceiling(), now=Clock())

    def dispatch(self, consent: security.Consent) -> security.Grant:
        """Read the whole form, write the one field the task is about."""
        return consent.grant(
            "the-mail-agent",
            classes=[],
            anchors=[
                security.Anchor(
                    target="el-compose-form",
                    classes=frozenset({"observe"}),
                    covers_descendants=True,
                ),
                security.Anchor(target="el-message", classes=frozenset({"observe", "edit"})),
            ],
            reason="fill in the message and leave the rest of the form alone",
        )

    def test_the_nearer_anchor_wins_over_the_one_above_it(self):
        """The composition rule, and the reason it is worth having.

        Both anchors cover this field: the form's because it covers its
        descendants, the field's because it names it. Neither had to be written
        with the other in mind, and the answer is still the specific one.
        """
        consent = self.consent()
        self.dispatch(consent)
        decision = consent.decide(
            method="typeText",
            operation_class="edit",
            client_id="the-mail-agent",
            ancestry=self.FIELD,
        )
        assert decision.allowed

    def test_the_wider_anchor_still_governs_everything_else_under_it(self):
        consent = self.consent()
        self.dispatch(consent)
        assert consent.decide(
            method="getElement",
            operation_class="observe",
            client_id="the-mail-agent",
            ancestry=self.SIBLING,
        ).allowed
        assert not consent.decide(
            method="typeText",
            operation_class="edit",
            client_id="the-mail-agent",
            ancestry=self.SIBLING,
        ).allowed

    def test_a_place_no_anchor_hangs_over_is_outside_the_grant(self):
        """Same rule the per-application form has: naming places unnames the rest."""
        consent = self.consent()
        self.dispatch(consent)
        decision = consent.decide(
            method="getElement",
            operation_class="observe",
            client_id="the-mail-agent",
            ancestry=self.ELSEWHERE,
        )
        assert not decision.allowed
        assert "el-compose-form" in decision.reason

    def test_an_anchor_that_does_not_cover_descendants_speaks_only_for_itself(self):
        """Otherwise every anchor would be a subtree, and the flag would be a lie."""
        consent = self.consent()
        consent.grant(
            "narrow",
            classes=[],
            anchors=[security.Anchor(target="el-compose-form", classes=frozenset({"edit"}))],
        )
        assert consent.decide(
            method="typeText",
            operation_class="edit",
            client_id="narrow",
            ancestry=("el-compose-form", "win-mail", "chrome"),
        ).allowed
        assert not consent.decide(
            method="typeText",
            operation_class="edit",
            client_id="narrow",
            ancestry=self.FIELD,
        ).allowed

    def test_an_anchor_may_hang_on_an_application(self):
        """The outermost place there is. The old form, said the new way."""
        consent = self.consent()
        consent.grant(
            "broad",
            classes=[],
            anchors=[
                security.Anchor(
                    target="chrome",
                    classes=frozenset({"edit"}),
                    covers_descendants=True,
                )
            ],
        )
        assert consent.decide(
            method="typeText",
            operation_class="edit",
            client_id="broad",
            ancestry=self.FIELD,
        ).allowed

    def test_an_anchor_on_an_id_is_matched_exactly(self):
        """An id is minted, not typed: a substring of one is a coincidence.

        Application names are matched as substrings because a person wrote them
        and cannot be expected to reproduce the desktop's own spelling. Nobody
        writes an element id by hand, and treating a prefix of one as a match
        would hang a permission on whatever else happened to start the same way.
        """
        consent = self.consent()
        consent.grant(
            "exact",
            classes=[],
            anchors=[security.Anchor(target="el-mess", classes=frozenset({"edit"}))],
        )
        assert not consent.decide(
            method="typeText",
            operation_class="edit",
            client_id="exact",
            ancestry=self.FIELD,
        ).allowed

    def test_an_application_name_never_matches_a_minted_id(self):
        """The other half of the same rule, and the widening one.

        Ancestry carries both kinds of name — element and window ids, then the
        application's id and its name. An application called "win" matched as a
        substring would cover every window on the desktop by spelling alone,
        which is a grant nobody wrote reaching a place nobody named.
        """
        consent = self.consent()
        consent.grant(
            "unlucky-name",
            classes=[],
            anchors=[
                security.Anchor(
                    target="win",
                    classes=frozenset({"edit"}),
                    covers_descendants=True,
                )
            ],
        )
        assert not consent.decide(
            method="typeText",
            operation_class="edit",
            client_id="unlucky-name",
            ancestry=self.FIELD,
            anchor_lives=lambda target: True,
        ).allowed

    def test_an_anchor_cannot_reach_past_the_ceiling(self):
        """A narrowing device, never a side door — the same rule per-application has."""
        consent = security.Consent(security.Ceiling(classes=frozenset({"observe", "edit"})))
        with pytest.raises(security.ScopeError):
            consent.grant(
                "sneaky",
                classes=["observe"],
                anchors=[security.Anchor(target="el-send", classes=frozenset({"submit"}))],
            )

    def test_an_anchor_naming_a_blocked_application_is_refused_when_asked_for(self):
        consent = security.Consent(
            security.Ceiling(
                classes=frozenset({"observe", "edit"}),
                blocked_applications=frozenset({"keepassxc"}),
            )
        )
        with pytest.raises(security.ScopeError):
            consent.grant(
                "hopeful",
                classes=["observe"],
                anchors=[security.Anchor(target="keepassxc", classes=frozenset({"edit"}))],
            )

    def test_an_anchor_that_names_nothing_is_refused(self):
        consent = self.consent()
        with pytest.raises(security.ScopeError):
            consent.grant(
                "vague",
                classes=[],
                anchors=[security.Anchor(target="  ", classes=frozenset({"edit"}))],
            )

    def test_an_anchor_always_carries_observe(self):
        """A client that may edit must be able to check whether its edit worked."""
        consent = self.consent()
        consent.grant(
            "writer",
            classes=[],
            anchors=[security.Anchor(target="el-message", classes=frozenset({"edit"}))],
        )
        assert consent.decide(
            method="getElement",
            operation_class="observe",
            client_id="writer",
            ancestry=self.FIELD,
        ).allowed

    def test_a_grant_with_no_anchors_costs_nothing_and_behaves_as_before(self):
        """The ancestry is offered on every call; a grant that hung nowhere ignores it."""
        consent = self.consent()
        consent.grant("plain", classes=["edit"], applications=["chrome"])
        assert consent.decide(
            method="typeText",
            operation_class="edit",
            client_id="plain",
            application="chrome",
            ancestry=self.ELSEWHERE,
        ).allowed

    def test_a_desktop_level_call_answers_from_the_general_hand(self):
        """Listing windows is not a question about a place inside one."""
        consent = self.consent()
        self.dispatch(consent)
        assert consent.decide(
            method="listWindows",
            operation_class="observe",
            client_id="the-mail-agent",
            ancestry=(),
        ).allowed

    def test_a_vanished_anchor_grants_nothing_and_says_which_one(self):
        """The trap this amendment exists for.

        The dialog closed. The grant still exists, still names the element, and
        the element is gone — so the next action must not be answered as a
        permission question, because re-asking for the same scope would produce
        the same grant and the same silence. It fails as a stale reference,
        which is the one answer that tells the client to go and look again.
        """
        consent = self.consent()
        self.dispatch(consent)
        with pytest.raises(DesktopError) as raised:
            consent.decide(
                method="typeText",
                operation_class="edit",
                client_id="the-mail-agent",
                ancestry=self.ELSEWHERE,
                anchor_lives=lambda target: target != "el-compose-form",
            )
        assert raised.value.code == ErrorCode.ELEMENT_REFERENCE_STALE
        assert "el-compose-form" in raised.value.message

    def test_an_ambiguous_anchor_is_treated_as_unresolved(self):
        """Two identical fields: handing back one of them is worse than admitting it died."""
        consent = self.consent()
        self.dispatch(consent)
        with pytest.raises(DesktopError) as raised:
            consent.decide(
                method="typeText",
                operation_class="edit",
                client_id="the-mail-agent",
                ancestry=self.ELSEWHERE,
                anchor_lives=lambda target: None,
            )
        assert raised.value.code == ErrorCode.ELEMENT_REFERENCE_STALE
        assert "more than one" in raised.value.message

    def test_a_living_anchor_that_simply_does_not_cover_this_place_is_a_refusal(self):
        """Staleness and refusal are different answers, and the client acts on them differently."""
        consent = self.consent()
        self.dispatch(consent)
        decision = consent.decide(
            method="typeText",
            operation_class="edit",
            client_id="the-mail-agent",
            ancestry=self.ELSEWHERE,
            anchor_lives=lambda target: True,
        )
        assert not decision.allowed
        assert decision.reason

    def test_the_anchors_are_not_resolved_while_the_grant_covers_the_target(self):
        """Criterion five, stated as behaviour rather than as a benchmark.

        Resolution is the expensive half, and an allowed call must never pay for
        it. The probe raises if it is consulted at all.
        """

        def never(target):
            raise AssertionError(f"resolved {target!r} on a call the grant already covered")

        consent = self.consent()
        self.dispatch(consent)
        assert consent.decide(
            method="typeText",
            operation_class="edit",
            client_id="the-mail-agent",
            ancestry=self.FIELD,
            anchor_lives=never,
        ).allowed

    def test_a_call_that_reaches_through_steps_asks_what_the_grant_holds_anywhere(self):
        """A batch has no place of its own, and its steps are each checked at theirs.

        Refusing it from the general hand would mean an anchored grant could
        never make a batch, and the client's way out would be to ask for the
        class across the whole desktop — which is the widening this is for.
        """
        consent = self.consent()
        consent.grant(
            "batcher",
            classes=[],
            anchors=[security.Anchor("el-send", frozenset({"submit"}))],
        )
        assert consent.decide(
            method="performActions",
            operation_class="submit",
            client_id="batcher",
            ancestry=(),
            reaches_through_steps=True,
            confirmed=True,
        ).allowed

    def test_a_batch_still_cannot_start_on_a_class_the_grant_holds_nowhere(self):
        consent = self.consent()
        self.dispatch(consent)
        assert not consent.decide(
            method="performActions",
            operation_class="submit",
            client_id="the-mail-agent",
            ancestry=(),
            reaches_through_steps=True,
        ).allowed

    def test_a_grant_built_directly_still_refuses_what_it_did_not_hang_over(self):
        """The rule lives in the grant, not only in how grants are issued."""
        grant = security.Grant(
            classes=frozenset({"observe", "submit"}),
            anchors=(security.Anchor("el-message", frozenset({"edit"})),),
        )
        assert grant.classes_at(self.FIELD) == frozenset({"observe", "edit"})
        assert grant.classes_at(self.ELSEWHERE) is None
