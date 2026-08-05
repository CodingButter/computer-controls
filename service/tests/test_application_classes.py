"""View-only here, interact there — decided by the user's file.

The allow-list already answers whether an application is reachable. It cannot
answer how far a client may go once it is in one, and that is the setting
people actually reach for: read my chat app, do not type in it. Until now the
only place that distinction could be written down was a per-connection grant,
which means it lasted as long as the connection and had to be asked for again
by every client that connected — a preference the user holds about their own
desktop, stored in the one place that forgets it.

Three things are pinned here. That a named application is capped whatever the
grant says, because a rule a wide grant can step over is not a rule. That
naming one application says nothing about the others, since the failure that
would hurt most is a file pinning one application to view-only and thereby
switching off every other application on the desktop. And that ticking
interact implies view: a client permitted to click a control it cannot read is
a client clicking blind.
"""

from __future__ import annotations

import pytest

from desktop_service import security


def ceiling(**scopes) -> security.Ceiling:
    return security.Ceiling.from_config(
        {"operationClasses": ["observe", "edit", "activate", "submit"], **scopes},
        "/tmp/config.json",
        exists=True,
    )


def consent(**scopes) -> security.Consent:
    return security.Consent(ceiling(**scopes))


def granted(subject: security.Consent, **kwargs) -> security.Consent:
    subject.grant(
        "c",
        classes=["observe", "edit", "activate", "submit"],
        reason="test",
        **kwargs,
    )
    return subject


# --- the ladder ------------------------------------------------------------


def test_interact_implies_view():
    assert security.implied_classes({"activate"}) == frozenset(
        {"observe", "edit", "activate"}
    )


def test_view_only_implies_nothing_above_it():
    assert security.implied_classes({"observe"}) == frozenset({"observe"})


def test_naming_nothing_implies_nothing():
    assert security.implied_classes(()) == frozenset()


def test_the_ladder_is_read_from_the_highest_class_named():
    assert security.implied_classes({"observe", "submit"}) == frozenset(
        {"observe", "edit", "activate", "submit"}
    )


def test_the_implication_is_never_written_back_into_the_file():
    # The file keeps the word the user chose; the ladder is applied when the
    # answer is read. A page that saved the expansion would show the user four
    # ticks they never made, and could not tell later which one they meant.
    c = ceiling(applicationClasses={"discord": ["activate"]})
    assert c.application_classes["discord"] == frozenset({"activate"})
    assert c.classes_for("discord") == frozenset({"observe", "edit", "activate"})


def test_the_implication_cannot_reach_past_the_general_ceiling():
    c = security.Ceiling.from_config(
        {
            "operationClasses": ["observe", "activate"],
            "applicationClasses": {"discord": ["activate"]},
        },
        "/tmp/config.json",
        exists=True,
    )
    assert c.classes_for("discord") == frozenset({"observe", "activate"})


# --- what the ceiling answers ----------------------------------------------


def test_an_application_the_file_never_named_gets_no_special_answer():
    c = ceiling(applicationClasses={"discord": ["observe"]})
    assert c.classes_for("slack") is None


def test_an_absent_map_answers_about_nothing():
    assert ceiling().classes_for("discord") is None


def test_the_desktop_itself_is_not_an_application():
    c = ceiling(applicationClasses={"discord": ["observe"]})
    assert c.classes_for("") is None


def test_an_entry_naming_nothing_permits_nothing():
    c = ceiling(applicationClasses={"discord": []})
    assert c.classes_for("discord") == frozenset()


def test_the_entry_matches_the_way_every_other_application_name_does():
    c = ceiling(applicationClasses={"discord": ["observe"]})
    assert c.classes_for("Discord Canary") == frozenset({"observe"})


# --- what the file refuses to mean -----------------------------------------


def test_an_unknown_class_is_refused_by_name():
    with pytest.raises(ValueError, match="discord"):
        ceiling(applicationClasses={"discord": ["interact"]})


def test_a_class_the_ceiling_withholds_everywhere_is_a_contradiction():
    with pytest.raises(ValueError, match="destructive"):
        ceiling(applicationClasses={"discord": ["destructive"]})


def test_a_map_that_is_not_a_map_is_refused():
    with pytest.raises(ValueError, match="applicationClasses"):
        ceiling(applicationClasses=["discord"])


# --- enforcement ------------------------------------------------------------


def decide(subject: security.Consent, klass: str, application: str):
    return subject.decide(
        method="performAction",
        operation_class=klass,
        client_id="c",
        application=application,
        confirmed=True,
    )


def test_a_view_only_application_answers_observation():
    subject = granted(consent(applicationClasses={"discord": ["observe"]}))
    assert decide(subject, "observe", "discord").allowed


def test_a_view_only_application_refuses_interaction_a_grant_would_allow():
    subject = granted(consent(applicationClasses={"discord": ["observe"]}))
    for klass in ("edit", "activate", "submit"):
        assert not decide(subject, klass, "discord").allowed


def test_the_refusal_names_the_configuration_rather_than_the_grant():
    # The client holds activate. Told only that it "holds observe" it would ask
    # for a wider grant, be given one, and be refused in the same place again.
    subject = granted(consent(applicationClasses={"discord": ["observe"]}))
    assert "configuration permits observe" in decide(subject, "activate", "discord").reason


def test_a_fully_permitted_application_is_unaffected():
    subject = granted(consent(applicationClasses={"discord": ["observe"]}))
    assert decide(subject, "submit", "slack").allowed


def test_no_map_at_all_is_the_behaviour_that_shipped():
    subject = granted(consent())
    assert decide(subject, "submit", "discord").allowed


def test_an_interact_application_admits_the_reads_an_interaction_is_made_of():
    subject = granted(consent(applicationClasses={"discord": ["activate"]}))
    assert decide(subject, "observe", "discord").allowed
    assert decide(subject, "edit", "discord").allowed
    assert decide(subject, "activate", "discord").allowed
    assert not decide(subject, "submit", "discord").allowed


def test_the_cap_holds_against_an_anchored_grant():
    # An anchor is the narrower way of naming a place, not a way around the
    # file: a grant hung on the application itself still meets the ceiling.
    subject = consent(applicationClasses={"discord": ["observe"]})
    subject.grant(
        "c",
        classes=["observe"],
        anchors=[security.Anchor(target="discord", classes=frozenset({"activate"}))],
        reason="test",
    )
    assert not subject.decide(
        method="performAction",
        operation_class="activate",
        client_id="c",
        application="discord",
        ancestry=("discord",),
        names_a_place=True,
        confirmed=True,
    ).allowed


def test_an_ungranted_client_still_observes_a_view_only_application():
    subject = consent(applicationClasses={"discord": ["observe"]})
    assert decide(subject, "observe", "discord").allowed


def test_a_saved_narrowing_bites_a_grant_that_was_already_issued():
    # The file is the only author, and every check reads the ceiling live, so a
    # checkbox ticked now does not wait for the client to reconnect.
    subject = granted(consent())
    assert decide(subject, "activate", "discord").allowed
    subject.reload_ceiling(ceiling(applicationClasses={"discord": ["observe"]}))
    assert not decide(subject, "activate", "discord").allowed


# --- asking for it -----------------------------------------------------------


def test_a_grant_naming_more_than_the_file_allows_there_is_refused_by_name():
    subject = consent(applicationClasses={"discord": ["observe"]})
    with pytest.raises(security.ScopeError, match="activate"):
        subject.grant(
            "c",
            classes=["observe"],
            per_application={"discord": ["activate"]},
            reason="test",
        )


def test_the_refusal_points_at_the_file_that_can_change_it():
    subject = consent(applicationClasses={"discord": ["observe"]})
    with pytest.raises(security.ScopeError) as raised:
        subject.grant(
            "c",
            classes=["observe"],
            per_application={"discord": ["activate"]},
            reason="test",
        )
    assert "/tmp/config.json" in raised.value.detail["remedy"]


def test_a_general_grant_across_a_narrowed_application_is_still_issued():
    # The general classes apply everywhere; the file narrowing one application
    # is the narrowing working, not a contradiction. Refusing the whole grant
    # would make one view-only application cost a client every other one.
    subject = granted(consent(applicationClasses={"discord": ["observe"]}))
    assert decide(subject, "activate", "slack").allowed
    assert not decide(subject, "activate", "discord").allowed


def test_a_per_application_entry_within_the_file_is_issued():
    subject = consent(applicationClasses={"discord": ["activate"]})
    issued = subject.grant(
        "c",
        classes=["observe"],
        per_application={"discord": ["edit"]},
        reason="test",
    )
    assert issued.per_application["discord"] == frozenset({"edit"})
