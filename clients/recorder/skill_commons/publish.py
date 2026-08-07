"""Publish one skill: the person is shown what will be sent, then sends it.

The commons is a folder the hub reads and never writes back through, and that is
deliberate — a commons the local agent could edit is a commons whose provenance
is a claim rather than a history. The way a skill changes is a proposal somebody
merges. This module is the *person's* half of opening that proposal, and it is
shaped by three rulings that all point the same way.

**What is shown is what is sent.** `preview()` renders the pair and answers with
the bytes; `publish()` takes that preview and sends those same bytes. There is
no overload that takes a `Skill`, so there is no path where the thing shown on
screen and the thing put on a server were produced by two separate calls that
could disagree — the second rendering that could drift from the first does not
exist. The fingerprint the person is shown is computed from the preview's own
two documents rather than stored beside them, so it cannot name a pair the
preview is no longer holding.

**One skill, one press.** The public surface takes a single preview. Nothing
here iterates a registry, and nothing here runs on a timer: a skill is offered
one at a time because it is read one at a time, and a machine that published a
batch would be asking for one yes and spending it several times.

**The credential is not here.** `GitHubForge` reaches the commons the way a
maintainer does — a checkout, `git`, `gh`, and whatever token is installed — and
that is exactly what a person who has never heard of a pull request does not
have. This path speaks to the project's own service instead (#160), over one
outbound request carrying two Markdown documents. Nothing in this module reads a
token, runs a subprocess, or asks who the local git identity belongs to; the
service holds the credential, and it re-runs the screens where they cannot be
skipped, because a gate that only ran on the contributor's machine is a gate a
modified client walks past.
"""

from __future__ import annotations

import hashlib
import json
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

from .curation import screen
from .outbound import over_http
from .render import render, render_review
from .skill import Skill
from .validator import Screen

#: How long to wait on the service before answering "it did not respond". A
#: publish that hangs is a button the person is still looking at.
TIMEOUT = 30.0


@dataclass(frozen=True)
class Preview:
    """The two documents, exactly as they would leave this machine.

    `document` is `SKILL.md` and `review` is `REVIEW.md`, both rendered in
    full. They are held as text rather than as the `Skill` they came from
    because a person cannot read a dataclass, and the thing shown to the person
    has to be the thing sent — not a rendering of the same object performed a
    second time by a second call.

    `screens` is what the local gate said. It is carried beside the documents
    rather than resolved into a boolean so that the person pressing the button
    is looking at the same answers the service will be given.
    """

    skill: str
    document: str
    review: str
    screens: tuple[Screen, ...]

    @property
    def admitted(self) -> bool:
        return all(check.passed for check in self.screens)

    @property
    def refusals(self) -> tuple[Screen, ...]:
        return tuple(check for check in self.screens if not check.passed)

    @property
    def reason(self) -> str:
        return "; ".join(check.reason for check in self.refusals)

    @property
    def fingerprint(self) -> str:
        """What these two documents are, in a word both ends can compare.

        Over the pair rather than over the skill: the skill is what this
        machine holds and the pair is what everybody else will read.
        """
        return fingerprint(self.document, self.review)


@dataclass(frozen=True)
class Receipt:
    """What happened after the button, in the terms the person asked in.

    A submission that vanishes into somebody else's review queue is a
    submission people stop making, so `where` names the proposal and `reason`
    says why not, and one of the two is always filled in.
    """

    skill: str
    accepted: bool
    where: str = ""
    reason: str = ""
    fingerprint: str = ""


class PublishingService(Protocol):
    """The half that owns a credential, as this machine needs to see it.

    One verb. A service this machine could ask for more than "please consider
    this pair" is a service this machine could be talked into asking for more.
    """

    def propose(self, *, skill: str, document: str, review: str) -> Receipt:
        """Offer one rendered pair for admission, and answer with what happened."""


class Publisher:
    """The publish verb: render, show, and only then send."""

    def __init__(self, service: PublishingService) -> None:
        self.service = service

    def preview(self, skill: Skill) -> Preview:
        """What the person will read, and what the gate said about it.

        Nothing is sent here. This is the whole of the "shown in full first"
        rule: the caller cannot reach `publish` without holding the bytes it
        would send, because that is the only argument it takes.
        """
        return Preview(
            skill=skill.name,
            document=render(skill),
            review=render_review(skill),
            screens=screen(skill).screens,
        )

    def publish(self, preview: Preview) -> Receipt:
        """Send the previewed pair, one skill, once.

        Refuses rather than raises when the screens turned the skill down: the
        caller asked what would happen if this were published, and "no, and
        here is which screen said so" is an answer to that question rather than
        a fault in asking it.
        """
        if not preview.admitted:
            return Receipt(
                skill=preview.skill,
                accepted=False,
                reason=preview.reason,
                fingerprint=preview.fingerprint,
            )

        return self.service.propose(
            skill=preview.skill,
            document=preview.document,
            review=preview.review,
        )


def fingerprint(document: str, review: str) -> str:
    """A name for one pair of documents, computed the same way at both ends."""
    digest = hashlib.sha256()
    digest.update(document.encode("utf-8"))
    digest.update(b"\0")
    digest.update(review.encode("utf-8"))
    return digest.hexdigest()[:16]


@dataclass
class HttpService:
    """The project's service, reached by one unauthenticated POST.

    `endpoint` is where the service listens. `transport` is injectable for the
    same reason the forge's runner is: what a test can prove without a network
    is that the request says what we meant, and that is the half that goes
    wrong.

    No `Authorization` header is set and none can be — this class has no field
    to put one in. That absence is the design: the contributor's machine has
    nothing worth stealing from it because it was never given anything, and a
    header that could be filled in from the environment would eventually be.
    """

    endpoint: str
    transport: Any = None
    timeout: float = TIMEOUT

    def propose(self, *, skill: str, document: str, review: str) -> Receipt:
        payload = json.dumps(
            {
                "version": 1,
                "skill": skill,
                "document": document,
                "review": review,
                "fingerprint": fingerprint(document, review),
            },
            sort_keys=True,
        ).encode("utf-8")

        request = urllib.request.Request(
            self.endpoint,
            data=payload,
            method="POST",
            headers={
                "content-type": "application/json",
                "accept": "application/json",
            },
        )

        send = self.transport or over_http
        try:
            status, body = send(request, self.timeout)
        except OSError as unreachable:
            # A service that could not be reached is not a refusal and not a
            # success; it is a thing to say out loud, because a button that
            # silently did nothing is a button pressed twice.
            return Receipt(
                skill=skill,
                accepted=False,
                reason=f"the publishing service could not be reached: {unreachable}",
                fingerprint=fingerprint(document, review),
            )

        return _receipt(skill, status, body, fingerprint(document, review))


def _receipt(skill: str, status: int, body: str, digest: str) -> Receipt:
    try:
        answered = json.loads(body) if body.strip() else {}
    except ValueError:
        answered = {}
    if not isinstance(answered, dict):
        answered = {}

    where = str(answered.get("where", ""))
    reason = str(answered.get("reason", ""))
    if status >= 400 or not where:
        return Receipt(
            skill=skill,
            accepted=False,
            reason=reason or f"the service answered {status} and named no proposal",
            fingerprint=digest,
        )
    return Receipt(skill=skill, accepted=True, where=where, fingerprint=digest)
