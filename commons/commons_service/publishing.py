"""The one verb: here is a rendered skill and its review; open a pull request for it.

There is exactly one of these, and the shape of it is the point. A service with a
second way to reach the forge would eventually be reached the way that skips the
screens — the same ruling `curation.py` makes about the machine-local gate, one
level up and with more at stake, because this one holds the credential.

The order the screens run in is deliberate.

The **gate** runs first and runs whole. `skill_commons.validate` is asked every
question it knows, against the pair this service rendered, and every screen is run
rather than stopping at the first no — a contributor who fixes one refusal and
resubmits into a second one has made two round trips to learn one thing.

**As shown** runs next. The submission carried the pair the contributor was
looking at when they pressed the button; this service renders its own and
compares. A mismatch is not a formatting quarrel, it is the case where somebody
approved text that is not the text that would be published, and the only safe
answer to it is a refusal that says so.

The **cap** runs last, because it is the only screen that costs a network call,
and asking the forge how many proposals an installation has open is not worth
doing for a submission that was never going to publish.

What is not a screen is the credential. It is checked at the moment of use rather
than at boot, because a token that was present when the process started is not a
token the forge will accept now — it expires, it gets revoked, the account gets
rate limited — and a service that decided at boot that it could publish would
answer a runtime failure with a success. So the forge is allowed to fail, and its
failure becomes a refusal like any other, with the upstream text withheld unless
it can be shown to carry nothing that should not be repeated.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable

from skill_commons import Screen, Skill, render, render_review, validate
from skill_commons.curation import Ledger, Submission
from skill_commons.forge import Forge, ForgeError

from .submission import MAX_BYTES, Refused, Submitted, read, safely

#: Where the credential lives: in this process's environment, put there by
#: whatever runs it, and read only to decide whether publishing is possible. It
#: is never logged, never echoed into a refusal and never part of a submission —
#: `submission.FIELDS` has no field it could arrive in.
TOKEN_ENV = "COMMONS_GITHUB_TOKEN"

#: How many proposals one installation may have open at once — the same number
#: `curation.CAP` uses, for the same reason it gives: triage happens at the
#: source rather than in a maintainer's inbox. Counted per installation rather
#: than for the service as a whole, because a shared allowance is an allowance
#: one enthusiastic machine spends on everybody else's behalf.
CAP = 3

#: How many proposals this service will open in an hour, whoever asks.
#:
#: The cap above is per installation, and an installation id arrives in the
#: payload. It is a pseudonym rather than a credential — nothing here
#: authenticates it, and nothing can, because the whole point of this service is
#: that a contributor has no account to authenticate with. So a client that
#: makes up a new id per submission has a fresh allowance every time, and the
#: cap is a courtesy to honest clients rather than a defence against dishonest
#: ones.
#:
#: This is the defence: a ceiling on the whole service, counted here, spent by
#: everybody together. It is deliberately generous — a busy day of real
#: contributions never reaches it — and it is deliberately low enough that the
#: worst a loop can do before somebody notices is a page of pull requests rather
#: than a repository nobody can read. Reaching it is a refusal with the window
#: in it, never a dropped connection.
RATE = 30
WINDOW = 3600.0

#: Given the installation a submission came from, the forge that proposes as it.
#: A callable rather than a single forge because the cap is per installation and
#: the forge finds its own proposals by the `proposed-by` trailer, so the
#: installation has to reach the forge to be counted. What does *not* vary is the
#: account: every proposal is posted by this service's credential, which is the
#: whole reason a contributor needs no GitHub account of their own.
Forges = Callable[[str], Forge]


@dataclass(frozen=True)
class Published:
    """A pull request exists, and this is where."""

    skill: str
    proposed: int
    credited: str = ""


def publish_disabled(environ: dict[str, str] | None = None) -> str:
    """Why this service cannot post right now, or an empty string.

    Read as set-or-not, the same as every other switch in this codebase. Exposed
    so that a deployment can be told it is misconfigured by something other than
    the first contributor to try.
    """
    environ = os.environ if environ is None else environ
    if environ.get(TOKEN_ENV, ""):
        return ""
    return (
        "this service has no credential to post with, so nothing was sent: this"
        " is a fault in the service and not in the skill, and the skill is"
        " unchanged on the machine that derived it"
    )


class Publisher:
    """The service, minus the socket.

    Everything a submission goes through lives here rather than in the HTTP
    layer, so that the transport is an adapter and the decisions are testable
    without one. `server.py` reads bytes off a socket and hands them to
    `publish`; it makes no decisions of its own.
    """

    def __init__(
        self,
        forges: Forges,
        *,
        ledger: Ledger | None = None,
        base: str = "main",
        cap: int = CAP,
        rate: int = RATE,
        window: float = WINDOW,
        limit: int = MAX_BYTES,
        environ: dict[str, str] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.forges = forges
        self.ledger = ledger
        self.base = base
        self.cap = cap
        self.rate = rate
        self.window = window
        self.limit = limit
        self.environ = environ
        self.clock = clock
        self._opened: deque[float] = deque()

        # One checkout, one `git`, one proposal at a time.
        #
        # `GitHubForge.propose` switches a branch, writes two files, commits and
        # pushes, in a working copy this process shares with every other request
        # it is serving. Two of those interleaved is not a slow path, it is the
        # failure `forge.py` cuts branches from `origin/{base}` to avoid,
        # reintroduced one level up: whichever commit lands second carries the
        # other submission's files, and a reviewer approves two skills while
        # reading one. The server is threaded because a refusal should not wait
        # behind a push; the push itself is not a thing to do twice at once.
        self._one_at_a_time = threading.Lock()

    def publish(self, request: bytes | str | dict) -> Published:
        """Screen a submission and, if every screen passes, open one pull request.

        Raises `Refused` for every no. A refusal is an outcome and it carries a
        vocabulary — the screens, each named, each with a sentence — because the
        thing on the other end of this is somebody's page and a page cannot be
        built out of a stack trace.
        """
        submitted = self._parse(request)
        screens = self._screen(submitted)

        refusals = tuple(screen for screen in screens if not screen.passed)
        if refusals:
            self._record(submitted.skill, screens, proposed=None)
            raise Refused(*refusals)

        try:
            disabled = publish_disabled(self.environ)
            if disabled:
                raise Refused(Screen("credential", False, disabled))

            forge = self.forges(submitted.skill.author.client_id)
            with self._one_at_a_time:
                self._within_the_rate()
                self._within_cap(forge)
                number = self._propose(forge, submitted)
                self._opened.append(self.clock())
        except Refused as refusal:
            self._record(
                submitted.skill, screens + refusal.screens, proposed=None
            )
            raise

        self._record(submitted.skill, screens, proposed=number)
        return Published(
            skill=submitted.skill.name,
            proposed=number,
            credited=submitted.attribution,
        )

    # -- the screens ----------------------------------------------------

    def _parse(self, request: bytes | str | dict) -> Submitted:
        if isinstance(request, (bytes, str)):
            raw = request.encode() if isinstance(request, str) else request
            if len(raw) > self.limit:
                raise Refused(
                    Screen(
                        "size",
                        False,
                        f"a submission is at most {self.limit} bytes and this"
                        f" one is {len(raw)}: a skill is a few kilobytes of"
                        " enumerated fields, so this is a refusal you can act"
                        " on rather than a connection that went quiet",
                    )
                )
            try:
                request = json.loads(raw or b"")
            except ValueError:
                raise Refused(
                    Screen(
                        "shape",
                        False,
                        "the submission is not JSON this service could read",
                    )
                ) from None
        return read(request)

    def _screen(self, submitted: Submitted) -> tuple[Screen, ...]:
        """Every question, asked here, whatever was asked on the way in.

        The contributor's machine ran these before it showed anybody anything,
        and that run is worth having — a refusal that arrives before a
        submission is a better refusal. It is not, however, evidence. A client
        that has been edited, or is simply older than this service, reports
        whatever it reports, and a gate that trusted the report would be a gate
        with a flag to skip it in the hands of the one party it exists to
        screen.
        """
        document = render(submitted.skill)
        review = render_review(submitted.skill)

        return validate(
            submitted.skill, rendered=document + "\n" + review
        ).screens + (_as_shown(submitted, document=document, review=review),)

    def _within_the_rate(self) -> None:
        """The ceiling on the whole service, held under the same lock as the push.

        Counted here rather than asked of the forge, because the question is
        "how fast is this service posting" and the forge can only answer "how
        many are open", which a loop that closes its own would answer nothing
        useful about. Checked and spent inside the lock so that two requests
        cannot both read a count of one below the ceiling.
        """
        now = self.clock()
        while self._opened and now - self._opened[0] >= self.window:
            self._opened.popleft()
        if len(self._opened) >= self.rate:
            raise Refused(
                Screen(
                    "rate",
                    False,
                    f"this service opens at most {self.rate} proposals per"
                    f" {int(self.window / 60)} minutes and has reached that,"
                    " so nothing was posted: the skill is unchanged where it"
                    " was derived and this can be sent again shortly",
                )
            )

    def _within_cap(self, forge: Forge) -> None:
        try:
            open_now = forge.open_requests()
        except ForgeError as failure:
            raise Refused(_upstream(failure)) from None
        if len(open_now) >= self.cap:
            raise Refused(
                Screen(
                    "cap",
                    False,
                    f"{len(open_now)} proposals from this installation are"
                    f" already open and the cap is {self.cap}: nothing was"
                    " dropped, and this one can be sent again once one of them"
                    " has been merged or closed",
                )
            )

    def _propose(self, forge: Forge, submitted: Submitted) -> int:
        try:
            return forge.propose(
                submitted.skill,
                base=self.base,
                credit=submitted.attribution,
            )
        except ForgeError as failure:
            raise Refused(_upstream(failure)) from None

    # -- the record -----------------------------------------------------

    def _record(
        self, skill: Skill, screens: tuple[Screen, ...], *, proposed: int | None
    ) -> None:
        """The gate's own ledger, in the gate's own format.

        Screen names and whether they passed, never what they matched on. The
        ruling is `curation.Ledger`'s and it is not relaxed by being on a
        server: a log that quoted the address it refused would take the one
        thing that must not be published and write it somewhere permanent.
        """
        if self.ledger is None:
            return
        self.ledger.record(
            Submission(
                skill=skill.name,
                admitted=proposed is not None,
                proposed=proposed,
                screens=screens,
                reason="",
            )
        )


def _as_shown(submitted: Submitted, *, document: str, review: str) -> Screen:
    """Is the pair this would publish the pair somebody looked at and approved?

    Byte for byte, both halves. A near miss is the interesting case rather than
    the harmless one: the pair is generated from the same tuple in both places,
    so the only ways it differs are a renderer that has drifted and a client
    that showed one thing and sent another, and neither is a difference to
    publish through.
    """
    if submitted.document == document and submitted.review == review:
        return Screen("as-shown", True)
    half = "skill" if submitted.document != document else "review"
    return Screen(
        "as-shown",
        False,
        f"the {half} this service would publish is not the one you were shown,"
        " so nothing was published: what you approved is the only thing that"
        " may be posted, and the two have to be identical for that to mean"
        " anything",
    )


def _upstream(failure: ForgeError) -> Screen:
    """The forge said no, in words it is safe to repeat, or in none at all.

    Upstream text is useful — `gh: not found` and `403 rate limited` are two
    very different mornings for whoever is on call — and it is also the one
    string in this process that has been anywhere near a credential. So it is
    run through the same scan the published text goes through, and repeated only
    if that scan finds nothing. A message withheld is worse for debugging and
    better than the alternative, which is a token in somebody's browser tab.
    """
    return Screen(
        "forge",
        False,
        safely(
            f"the forge refused and nothing was published: {failure}",
            instead="the forge refused and what it said was withheld, because"
            " it carried something shaped like a credential or a link: nothing"
            " was published, and this is a fault in the service rather than in"
            " the skill",
        ),
    )
