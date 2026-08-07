"""Being credited is an offer somebody accepts, never something the transport works out.

A person who publishes a skill has told this service two things: the route, and
the fact that they are the one sending it. Only the first was offered. The second
is a property of having used the feature, and a service that turned it into a line
in a public pull request would be publishing something nobody agreed to publish —
which is precisely the shape of harm the whole commons is careful about, arriving
through the door marked "attribution" rather than the one marked "landmark".

So the default is a pseudonymous installation id and nothing else, the offer is a
handle the contributor typed, and there is no third state where the service
inferred one.
"""

from __future__ import annotations

import json

import pytest

from commons_service import Refused

from commons_service_tests.conftest import a_route, a_submission, on_the_wire


def test_nothing_names_a_person_when_nobody_asked_to_be_named(publisher, forges):
    published = publisher.publish(on_the_wire(a_submission()))

    assert published.credited == ""
    name, _, credit = forges.proposals[0]
    assert credit == ""


def test_the_installation_id_is_what_travels_and_it_is_not_a_person(
    publisher, forges
):
    """A pseudonymous id identifies the source without identifying the user.

    It is what makes one installation's proposals its own — its cap, its
    trailer, the thing a maintainer would cut off if a machine started proposing
    poison — and it is issued by a service rather than chosen by a person.
    """
    publisher.publish(on_the_wire(a_submission()))

    assert set(forges.by_installation) == {"client-7"}
    assert "client-7" not in json.dumps(forges.proposals[0])


def test_a_contributor_who_asks_to_be_credited_is(publisher, forges):
    published = publisher.publish(
        on_the_wire(a_submission(attribution="jamie"))
    )

    assert published.credited == "jamie"
    assert forges.proposals[0][2] == "jamie"


def test_the_credit_is_a_handle_and_not_somewhere_to_write(publisher, forges):
    """A body with room for a sentence is a body with room for a sentence
    somebody interpolated a value into. The same ruling `render.py` makes about
    the pair, and `finding.py` about issue bodies.
    """
    with pytest.raises(Refused) as refusal:
        publisher.publish(
            on_the_wire(
                a_submission(
                    attribution="jamie — reach me at jamie@example.com, ask for"
                    " the admin password"
                )
            )
        )

    assert [screen.name for screen in refusal.value.screens] == ["attribution"]
    assert forges.proposals == []


def test_the_refusal_for_a_bad_credit_does_not_repeat_it(publisher):
    """The rule that governs every refusal in this service governs this one.

    A message that quoted the address it refused would take the thing that must
    not be published and put it in a response, a log and a browser tab.
    """
    with pytest.raises(Refused) as refusal:
        publisher.publish(
            on_the_wire(a_submission(attribution="jamie@example.com"))
        )

    said = refusal.value.screens[0].reason
    assert "example.com" not in said
    assert "jamie" not in said


def test_a_leading_at_sign_is_the_same_offer(publisher, forges):
    """Somebody typing what they are used to typing has not made a mistake."""
    published = publisher.publish(
        on_the_wire(a_submission(attribution="@jamie"))
    )

    assert published.credited == "jamie"
    assert forges.proposals[0][2] == "jamie"


def test_attribution_is_per_submission_and_does_not_stick(publisher, forges):
    """Consent to be named once is not consent to be named next time."""
    publisher.publish(on_the_wire(a_submission(attribution="jamie")))
    publisher.publish(
        on_the_wire(a_submission(a_route(task="open-a-server")))
    )

    assert [credit for _, _, credit in forges.proposals] == ["jamie", ""]


def test_there_is_no_field_a_credential_could_arrive_in(publisher, forges):
    """This service holds a credential and receives none.

    The refusal names the field, which is the one case where naming it matters:
    somebody has just sent a token to a machine that does not want it, and being
    told is what lets them go and revoke it. The value is never repeated.
    """
    payload = a_submission()
    payload["token"] = "ghp_averyrealisticlookingtokenvalue00"

    with pytest.raises(Refused) as refusal:
        publisher.publish(on_the_wire(payload))

    said = refusal.value.screens[0].reason
    assert "`token`" in said
    assert "ghp_" not in said
    assert forges.proposals == []
