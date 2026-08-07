"""A no arrives with reasons somebody's page can render, and never with silence.

The failure this file is written against is not a security one. It is a
contributor who did nothing wrong, got nothing back, and concluded the feature is
broken — and the one thing worse for a commons than a bad submission is a good one
nobody sent twice.

So every refusal carries screens: each with a name from a closed vocabulary, so a
client can branch on it, and each with a sentence, so a person can read it. The
limits are refusals too. A size cap enforced by dropping a connection and a rate
cap enforced by ignoring a request are both indistinguishable from an outage, and
a contributor cannot work inside a limit nobody told them about.

What a refusal must never contain is what it refused. The gate's ledger has held
that line since `curation.py`, for the reason given there: a record that quoted
the address it caught would take the one thing that must not be published and
write it somewhere permanent, helpfully, in the name of an audit trail. A response
body is more public than a ledger, not less.
"""

from __future__ import annotations

import json

import pytest

from skill_commons.curation import Ledger, refusals_in

from commons_service import Publisher, Refused
from commons_service.publishing import TOKEN_ENV
from commons_service.server import outcome

from commons_service_tests.conftest import a_route, a_submission, on_the_wire


def test_every_refusal_names_a_screen_and_gives_a_sentence(publisher):
    with pytest.raises(Refused) as refusal:
        publisher.publish(on_the_wire(a_submission(a_route(app="keepassxc"))))

    for screen in refusal.value.screens:
        assert screen.name and " " not in screen.name
        assert len(screen.reason.split()) >= 5


def test_a_submission_too_large_is_told_the_limit(forges, credentialled):
    """Not a dropped connection. A number, and the number that was exceeded."""
    publisher = Publisher(forges, environ=credentialled, limit=512)

    with pytest.raises(Refused) as refusal:
        publisher.publish(on_the_wire(a_submission()))

    screen = refusal.value.screens[0]
    assert screen.name == "size"
    assert "512" in screen.reason
    assert forges.proposals == []


def test_a_contributor_at_the_cap_is_told_what_the_cap_is(forges, credentialled):
    publisher = Publisher(forges, environ=credentialled, cap=2)

    first = publisher.publish(on_the_wire(a_submission()))
    second = publisher.publish(
        on_the_wire(a_submission(a_route(task="open-a-server")))
    )
    with pytest.raises(Refused) as refusal:
        publisher.publish(
            on_the_wire(a_submission(a_route(task="join-a-voice-channel")))
        )

    screen = refusal.value.screens[0]
    assert screen.name == "cap"
    assert "cap is 2" in screen.reason
    assert "again" in screen.reason
    assert [first.proposed, second.proposed] == [200, 201]


def test_the_service_ceiling_is_a_refusal_with_the_window_in_it(
    forges, credentialled
):
    """The cap is per installation, and an installation id is not a credential.

    Nothing authenticates it and nothing can — a contributor has no account here,
    which is the point of the whole service. So a client that invents a new id
    per submission has a fresh allowance every time, and the per-installation cap
    is a courtesy to honest clients rather than a limit on dishonest ones. The
    ceiling on the service as a whole is the one that holds, and it is a refusal
    with the window in it rather than a connection nobody answers.
    """
    at = [0.0]
    publisher = Publisher(
        forges, environ=credentialled, rate=2, window=60.0, clock=lambda: at[0]
    )

    def from_a_fresh_installation(task: str, client: str) -> dict:
        route = a_route()
        return a_submission(
            a_route(
                task=task,
                author=route.author.__class__(client_id=client),
            )
        )

    publisher.publish(on_the_wire(from_a_fresh_installation("one", "client-1")))
    publisher.publish(on_the_wire(from_a_fresh_installation("two", "client-2")))

    with pytest.raises(Refused) as refusal:
        publisher.publish(
            on_the_wire(from_a_fresh_installation("three", "client-3"))
        )

    screen = refusal.value.screens[0]
    assert screen.name == "rate"
    assert "2 proposals per 1 minutes" in screen.reason
    assert "shortly" in screen.reason
    assert len(forges.proposals) == 2


def test_the_ceiling_is_a_window_and_not_a_wall(forges, credentialled):
    """A limit that never lifts is an outage with a nicer message."""
    at = [0.0]
    publisher = Publisher(
        forges, environ=credentialled, rate=1, window=60.0, clock=lambda: at[0]
    )

    publisher.publish(on_the_wire(a_submission()))
    with pytest.raises(Refused):
        publisher.publish(on_the_wire(a_submission(a_route(task="open-a-server"))))

    at[0] = 61.0
    published = publisher.publish(
        on_the_wire(a_submission(a_route(task="open-a-server")))
    )

    assert published.proposed == 201


def test_a_refused_submission_does_not_spend_the_ceiling(forges, credentialled):
    """The limit counts what was posted, not what was asked.

    A screen that counted refusals would let a client with a malformed payload
    lock everybody else out of the service by sending it in a loop.
    """
    at = [0.0]
    publisher = Publisher(
        forges, environ=credentialled, rate=1, window=60.0, clock=lambda: at[0]
    )

    for _ in range(5):
        with pytest.raises(Refused):
            publisher.publish(on_the_wire(a_submission(a_route(app="keepassxc"))))

    assert publisher.publish(on_the_wire(a_submission())).proposed == 200


def test_one_installation_at_the_cap_does_not_spend_anothers(forges, credentialled):
    """The allowance is per installation, so one enthusiast cannot close the door."""
    publisher = Publisher(forges, environ=credentialled, cap=1)

    publisher.publish(on_the_wire(a_submission()))
    other = a_route(author=a_route().author.__class__(client_id="client-9"))

    assert publisher.publish(on_the_wire(a_submission(other))).proposed == 200


def test_a_service_with_no_credential_says_so_and_says_it_is_not_your_fault(forges):
    """The fault is the deployment's, and the message has to say which.

    A contributor told only "could not publish" goes and edits a route that was
    never the problem.
    """
    publisher = Publisher(forges, environ={})

    with pytest.raises(Refused) as refusal:
        publisher.publish(on_the_wire(a_submission()))

    screen = refusal.value.screens[0]
    assert screen.name == "credential"
    assert "fault in the service" in screen.reason
    assert forges.proposals == []


def test_the_credential_is_checked_when_it_is_used_and_not_only_at_boot(forges):
    """A token present at boot is not a token the forge will accept now.

    It expires, it gets revoked, the account gets rate limited. A service that
    settled the question at startup would answer a runtime failure with a
    success, so the failure gets a branch of its own.
    """
    environ = {TOKEN_ENV: "a-token-lives-here"}
    publisher = Publisher(forges, environ=environ)
    assert publisher.publish(on_the_wire(a_submission())).proposed == 200

    environ.clear()
    with pytest.raises(Refused) as refusal:
        publisher.publish(
            on_the_wire(a_submission(a_route(task="open-a-server")))
        )
    assert refusal.value.screens[0].name == "credential"


def test_a_forge_that_will_not_answer_is_a_refusal_not_a_traceback(
    publisher, forges
):
    forges("client-7").fail_with = "gh pr create failed: 403 rate limited"

    with pytest.raises(Refused) as refusal:
        publisher.publish(on_the_wire(a_submission()))

    screen = refusal.value.screens[0]
    assert screen.name == "forge"
    assert "403 rate limited" in screen.reason


def test_what_the_forge_said_is_withheld_when_it_carries_a_credential(
    publisher, forges
):
    """Upstream text is useful and is the one string here that has been near a token.

    So it goes through the same scan the published text goes through, and is
    repeated only if that scan finds nothing.
    """
    forges("client-7").fail_with = (
        "remote: https://x-access-token:ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaa@github.com"
    )

    with pytest.raises(Refused) as refusal:
        publisher.publish(on_the_wire(a_submission()))

    screen = refusal.value.screens[0]
    assert screen.name == "forge"
    assert "ghs_" not in screen.reason
    assert "github.com" not in screen.reason
    assert "withheld" in screen.reason


def test_a_refusal_does_not_repeat_what_it_refused(forges, credentialled):
    """The rendered text carried something key-shaped; the refusal names the shape.

    Naming the shape is the useful half — somebody can go and look at the field
    they filled in. Quoting the value would put it in a response body, a client
    log and a browser tab, which is three more places than it was.
    """
    publisher = Publisher(forges, environ=credentialled)
    secretive = a_route(task="read-3f8a1c9e4b7d2a6f0e5c8b1d4a")

    with pytest.raises(Refused) as refusal:
        publisher.publish(on_the_wire(a_submission(secretive)))

    said = " ".join(screen.reason for screen in refusal.value.screens)
    assert "content-free" in [screen.name for screen in refusal.value.screens]
    assert "shaped like a key" in said
    assert "3f8a1c9e4b7d2a6f0e5c8b1d4a" not in said


def test_the_answer_on_the_wire_is_a_document_a_page_can_render(publisher):
    status, document = outcome(
        publisher, on_the_wire(a_submission(a_route(app="lastpass")))
    )

    assert status == 422
    assert document["published"] is False
    assert {"screen", "because"} == set(document["refusals"][0])
    assert any(entry["screen"] == "application" for entry in document["refusals"])


def test_a_fault_of_ours_is_a_different_status_from_a_fault_of_theirs(forges):
    """A client should retry one of these and must not retry the other."""
    ours = Publisher(forges, environ={})
    theirs = Publisher(forges, environ={TOKEN_ENV: "a-token-lives-here"})

    assert outcome(ours, on_the_wire(a_submission()))[0] == 503
    assert outcome(theirs, on_the_wire(a_submission(a_route(app="keepass"))))[0] == 422


def test_a_limit_answers_with_the_status_that_names_it(forges, credentialled):
    """`413` and `429` say what `422` cannot: this is a limit, not a judgement."""
    small = Publisher(forges, environ=credentialled, limit=512)
    capped = Publisher(forges, environ=credentialled, cap=0)

    assert outcome(small, on_the_wire(a_submission()))[0] == 413
    assert outcome(capped, on_the_wire(a_submission()))[0] == 429


def test_a_submission_that_publishes_answers_with_where_it_went(publisher):
    status, document = outcome(publisher, on_the_wire(a_submission()))

    assert status == 201
    assert document["pullRequest"] == 200
    assert document["skill"] == "discord-read-latest-direct-message"


def test_the_same_answers_arrive_over_a_real_socket(publisher):
    """The transport is an adapter, and this is the proof it adapts.

    Everything else in this file asks the publisher directly, because that is
    where the decisions are. This one binds a port and sends two requests — one
    that publishes and one that does not — so that nothing in the layer between
    can quietly disagree with the layer that decided.
    """
    import json as _json
    import threading
    from urllib.error import HTTPError
    from urllib.request import Request, urlopen

    from commons_service.server import ROUTE, serve

    httpd = serve(publisher, port=0)
    host, port = httpd.server_address[:2]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        where = f"http://{host}:{port}{ROUTE}"
        with urlopen(
            Request(where, data=on_the_wire(a_submission()), method="POST")
        ) as answered:
            assert answered.status == 201
            assert _json.load(answered)["pullRequest"] == 200

        with pytest.raises(HTTPError) as failed:
            urlopen(
                Request(
                    where,
                    data=on_the_wire(a_submission(a_route(app="enpass"))),
                    method="POST",
                )
            )
        assert failed.value.code == 422
        refusals = _json.load(failed.value)["refusals"]
        assert [entry["screen"] for entry in refusals] == ["application"]
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_the_refusals_are_recorded_so_the_gate_can_be_watched(
    forges, credentialled, ledger_path
):
    """A screen nobody can see working is a screen nobody notices has stopped."""
    ledger = Ledger(ledger_path)
    publisher = Publisher(forges, environ=credentialled, ledger=ledger)

    publisher.publish(on_the_wire(a_submission()))
    with pytest.raises(Refused):
        publisher.publish(on_the_wire(a_submission(a_route(app="dashlane"))))

    records = ledger.read()
    assert [record["admitted"] for record in records] == [True, False]
    assert list(refusals_in(ledger))[0]["refused_for"] == ["application"]


def test_a_shape_refusal_names_the_field_and_does_not_repeat_it_over_the_wire(
    forges, credentialled, ledger_path
):
    """`skill.py` quotes what it refused; this service does not pass that on.

    On the machine that derived the route, quoting is right — the value is on
    that machine already, and a refusal that will not say which field is one
    nobody can act on. Across a wire the same words land in a response body, in
    whatever sits between here and the browser, and in whatever the client
    writes down, so a message that trips the content screen is replaced rather
    than forwarded. The sender is not left guessing: the machine they sent it
    from screens the same fields and can name the one that failed.
    """
    ledger = Ledger(ledger_path)
    publisher = Publisher(forges, environ=credentialled, ledger=ledger)

    payload = a_submission()
    payload["skill"]["steps"][3]["landmark"] = "Messages from Alice at 12 Rowan Street"

    with pytest.raises(Refused) as refusal:
        publisher.publish(on_the_wire(payload))

    said = refusal.value.screens[0].reason
    assert [screen.name for screen in refusal.value.screens] == ["shape"]
    assert "Rowan" not in said and "withheld" in said
    assert "Rowan" not in json.dumps(ledger.read())
    assert forges.proposals == []


def test_a_shape_refusal_that_holds_nothing_sensitive_says_which_field(publisher):
    """Withholding is the exception, not the posture.

    A method that is a sentence, a role nobody uses, a date that is not one —
    these carry nothing, and refusing them without saying which field would make
    every ordinary mistake a guessing game.
    """
    payload = a_submission()
    payload["skill"]["steps"][1]["role"] = "not a role anybody uses"

    with pytest.raises(Refused) as refusal:
        publisher.publish(on_the_wire(payload))

    assert "role" in refusal.value.screens[0].reason


def test_the_record_names_screens_and_never_quotes_them(
    forges, credentialled, ledger_path
):
    ledger = Ledger(ledger_path)
    publisher = Publisher(forges, environ=credentialled, ledger=ledger)

    publisher.publish(on_the_wire(a_submission()))

    written = json.dumps(ledger.read())
    assert "Private channels" not in written
    assert "describeElement" not in written
