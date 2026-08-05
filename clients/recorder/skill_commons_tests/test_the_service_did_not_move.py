"""The vocabularies this package copied, held against the ones it copied them from.

Two lists in `skill_commons` are the service's rather than this package's: the
element roles a step may name, and the applications whose contents the service
withholds. Neither is imported. The recorder and everything beside it is a
client of the desktop service — it opens no socket of the service's and imports
nothing of the service's — and a client that reached into the service's modules
for a constant would be a client only as far as the import line.

So they are copied, and copies rot. This file is what makes the rot loud: a
backend that learns a new role, or a configuration that adds a password manager
nobody here has heard of, fails here rather than quietly producing a skill that
could not be published or one that should not have been.
"""

from __future__ import annotations

from desktop_service import redaction

from episode_recorder.finding import ROLES

from skill_commons import SENSITIVE_APPLICATIONS
from skill_commons.skill import Step


def test_the_roles_a_step_may_name_are_the_ones_the_recorder_knows():
    """One vocabulary between the two packages, not two that agree today.

    A skill's step and a reviewer's finding both name an element role, and they
    have to mean the same thing by it or a route derived from a finding cannot
    be published as a skill.
    """
    for role in sorted(ROLES):
        assert Step(ordinal=1, method="describeElement", role=role).role == role


def test_the_applications_refused_here_are_the_ones_the_service_withholds():
    assert SENSITIVE_APPLICATIONS == redaction.DEFAULT_SENSITIVE_APPLICATIONS


def test_a_password_field_is_a_role_a_skill_could_name_and_a_screen_still_catches():
    """The two locks are independent, and this says so.

    `password text` is a legitimate role — the service reports it, and a route
    that walks past a login form has every right to say so. What is refused is
    the application, not the role, so a skill for an ordinary application that
    happens to contain a password field is publishable and a skill for a vault
    is not, whatever roles it names.
    """
    assert "password text" in ROLES
    assert Step(ordinal=1, method="describeElement", role="password text")
