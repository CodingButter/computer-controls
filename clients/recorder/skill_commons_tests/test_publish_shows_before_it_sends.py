"""The person reads the whole thing first, and that is the thing that goes.

Publishing is one press of one button, and the press means something only if
what was on the screen above it is what left the machine. A dialog saying "this
skill looks safe to share" is a summary, and a summary is an argument — the
reviewer who has read a persuasive argument for a poisoned skill has been
prepared to approve it. So the surface here is the rendered pair in full: the
skill as every other machine will read it, and the review that justifies every
landmark in it.

The structural half of that promise is that `publish` cannot be called with
anything except the preview. There is no path that takes a `Skill`, renders it
a second time, and sends the second rendering — the file these tests would
otherwise have to guard by convention does not have the seam to guard.
"""

from __future__ import annotations

import pytest

from skill_commons import Preview, Publisher, Verification, render, render_review

from skill_commons_tests.conftest import FakeService, a_route


@pytest.fixture
def publisher(service: FakeService) -> Publisher:
    return Publisher(service)


def test_the_preview_is_the_whole_skill_and_the_whole_review(publisher, route):
    """Not an excerpt, not a summary — both files, entire."""
    shown = publisher.preview(route)

    assert shown.document == render(route)
    assert shown.review == render_review(route)


def test_the_preview_carries_the_landmarks_the_reviewer_has_to_read(
    publisher, route
):
    """The one field an application's own words can reach is on the screen.

    A landmark passes the shape check and can still be a person's name, which
    is the whole reason a human reads this. If the preview did not carry it,
    the button would be asking for a yes to something unseen.
    """
    shown = publisher.preview(route)

    assert "Private channels" in shown.document
    assert "Private channels" in shown.review


def test_the_preview_says_what_the_screens_said(publisher, route):
    shown = publisher.preview(route)

    assert shown.admitted
    assert {check.name for check in shown.screens} == {
        "recurrence",
        "application",
        "navigable",
        "content-free",
    }


def test_nothing_is_sent_by_looking(publisher, route, service):
    """A preview is a preview. Reading is not publishing."""
    publisher.preview(route)

    assert service.proposals == []


def test_what_is_sent_is_what_was_shown(publisher, route, service):
    shown = publisher.preview(route)
    receipt = publisher.publish(shown)

    assert service.last["document"] == shown.document
    assert service.last["review"] == shown.review
    assert service.last["skill"] == shown.skill
    assert receipt.accepted


def test_publishing_cannot_re_render_behind_the_preview(publisher, service):
    """The bytes are the argument, not the skill they came from.

    If `publish` took a `Skill` it would render it again, and a second
    rendering is a second chance for the sent text to differ from the read
    text. It takes the preview, so the only text it can reach is the text the
    preview is holding — even when that text is not what this package would
    render today.
    """
    edited = Preview(
        skill="discord-read-latest-direct-message",
        document="# not what any renderer would produce\n",
        review="# nor this\n",
        screens=publisher.preview(a_route()).screens,
    )

    publisher.publish(edited)

    assert service.last["document"] == "# not what any renderer would produce\n"


def test_the_fingerprint_names_the_pair_that_is_held(publisher, route):
    """The word shown beside the two documents is computed from them.

    Stored beside them it could name a pair the preview no longer holds; a
    fingerprint that can go stale is a fingerprint that reassures.
    """
    shown = publisher.preview(route)
    other = publisher.preview(a_route(task="open-the-member-list"))

    assert shown.fingerprint != other.fingerprint
    assert shown.fingerprint == publisher.preview(route).fingerprint


def test_a_refused_skill_is_shown_its_refusal_and_stays_home(publisher, service):
    """The screens answer before the button, not after it.

    A person who presses publish on a skill the screens will refuse should
    learn that from the preview they are reading, and the refusal should say
    which screen and why — a refusal nobody can act on is a refusal that gets
    worked around.
    """
    once = a_route(
        verification=Verification(
            app_version="1.0.151", when="2026-08-05", successes=1
        )
    )
    shown = publisher.preview(once)

    assert not shown.admitted
    assert "recurrence" in {check.name for check in shown.refusals}
    assert shown.reason

    receipt = publisher.publish(shown)

    assert not receipt.accepted
    assert receipt.reason == shown.reason
    assert service.proposals == []
