"""The screens a skill passes before anything about it leaves the machine.

`skill.py` refuses at construction: a step whose method is a sentence, a role
nobody uses, a landmark with a password in it. That is the strong lock, and it
is strong because it is a shape check on a structured field rather than a
judgement about text.

This file is the second lock, and it exists because of what gets published. The
thing that lands in the repository is not the dataclass; it is two Markdown
files rendered from it. So the rendered text is read once more, and it is read
for the shapes that must never appear anywhere — an address, a card number, a
key, a URL somebody could be tracked by. Nothing here inspects meaning. The
service's own redaction policy is explicit that guessing from content produces a
redaction nobody can reason about, and that ruling holds here: these are
patterns, they are enumerated, and a reader can tell exactly what they refuse.

Two of the screens are not about text at all.

**The bar.** A route that has worked once is a candidate. The recorder already
draws this line for findings — once is an incident, twice is a pattern — and it
is the same line here for the same reason: a route that worked once and was
published is a route the commons will hand to a stranger on the strength of an
accident.

**The application.** A skill for a password manager is refused whatever it says,
because the interesting elements in a password manager are the ones the service
redacts, and a route through them is a route somebody would follow with a
password on the other end. The list is the service's own, held against it by a
test rather than imported, because this package is a client of the desktop
service and imports nothing from it.

What none of this does is decide whether `Private channels` is a piece of
application chrome or somebody's name. That question is answered by a person
reading the review, and the screens here exist to make sure the person only has
to answer that one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .skill import BAR, Skill

#: Applications whose contents the desktop service withholds from an agent
#: entirely. A copy rather than an import: the recorder and everything beside it
#: is a client of the service and opens nothing of the service's, so this is
#: held against `desktop_service.redaction.DEFAULT_SENSITIVE_APPLICATIONS` by a
#: test, and drift fails there rather than quietly here.
SENSITIVE_APPLICATIONS = frozenset(
    {
        "bitwarden",
        "1password",
        "keepassxc",
        "keepass",
        "lastpass",
        "dashlane",
        "enpass",
        "seahorse",
        "gnome-keyring",
        "keyring",
        "polkit",
        "gcr-prompter",
        "ssh-askpass",
        "pinentry",
        "authenticator",
    }
)

#: Shapes that are never a landmark, a method or a version, and are always
#: something somebody would rather not have published. Enumerated, so that what
#: this refuses can be read rather than inferred. Each is paired with what to
#: say when it matches, because "rejected by pattern 3" is not a reason.
PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "an email address",
        re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    ),
    (
        # Nine digits, not eight. A version and an ISO date are both runs of
        # digits with separators in them, and a screen that refused every
        # skill for carrying the date it was verified on would be switched off
        # within a week — which is the failure mode of an over-eager pattern,
        # and it is worse than the one it was guarding against.
        "a telephone number",
        re.compile(r"(?<![0-9])\+?(?:[0-9][ ().-]{0,2}){8,}[0-9](?![0-9])"),
    ),
    (
        "a street address",
        re.compile(
            r"(?<![0-9])[0-9]{1,5}\s+[A-Z][A-Za-z]+\s+"
            r"(Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Court|Ct|Way)\b"
        ),
    ),
    (
        "a payment card number",
        re.compile(r"(?<![0-9])(?:[0-9]{4}[ -]?){3}[0-9]{4}(?![0-9])"),
    ),
    (
        "a link somebody could be followed by",
        re.compile(r"\bhttps?://\S+"),
    ),
    (
        "something shaped like a key or a token",
        re.compile(r"\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b"),
    ),
)


@dataclass(frozen=True)
class Screen:
    """One question asked of a skill, and what it answered."""

    name: str
    passed: bool
    reason: str = ""


@dataclass(frozen=True)
class Verdict:
    """Every screen's answer, and whether that adds up to a yes.

    The screens are all run rather than stopped at the first failure. A skill
    refused for three reasons that is fixed for one and resubmitted is a round
    trip nobody needed, and the cost of asking the remaining questions is
    nothing.
    """

    screens: tuple[Screen, ...]

    @property
    def admitted(self) -> bool:
        return all(screen.passed for screen in self.screens)

    @property
    def refusals(self) -> tuple[Screen, ...]:
        return tuple(screen for screen in self.screens if not screen.passed)

    @property
    def reason(self) -> str:
        """Why this was refused, in one line, or an empty string."""
        return "; ".join(screen.reason for screen in self.refusals)


def scan(text: str) -> tuple[str, ...]:
    """What must not be published that appears in this text, if anything.

    Answers with what was found rather than with a boolean, because a caller
    that is told only `False` has to guess, and a refusal nobody can act on is
    a refusal that gets worked around.
    """
    found: list[str] = []
    for what, pattern in PATTERNS:
        if pattern.search(text) and what not in found:
            found.append(what)
    return tuple(found)


def validate(skill: Skill, *, rendered: str = "") -> Verdict:
    """Ask a skill every question that must be answered before it is published.

    `rendered` is the published text — the two Markdown files, joined. It is
    optional so that the structural screens can be run on a skill that has not
    been rendered yet; a curation gate passes it, and a gate that did not would
    be screening the dataclass and publishing the document.
    """
    screens: list[Screen] = [
        _over_the_bar(skill),
        _not_a_secret_keeper(skill),
        _goes_somewhere(skill),
    ]
    if rendered:
        screens.append(_carries_nothing_it_read(rendered))
    return Verdict(screens=tuple(screens))


def _over_the_bar(skill: Skill) -> Screen:
    if skill.over_the_bar:
        return Screen("recurrence", True)
    return Screen(
        "recurrence",
        False,
        f"the route has worked {skill.verification.successes} time(s) and the bar"
        f" is {BAR}: once is an incident, twice is a procedure",
    )


def _not_a_secret_keeper(skill: Skill) -> Screen:
    for sensitive in sorted(SENSITIVE_APPLICATIONS):
        if sensitive in skill.app:
            return Screen(
                "application",
                False,
                f"`{skill.app}` is an application the service withholds the"
                " contents of; a route through one is not published here",
            )
    return Screen("application", True)


def _goes_somewhere(skill: Skill) -> Screen:
    """A route has to be followable by somebody who was not there.

    A skill whose every step is a bare call with no role and no landmark reads
    as a procedure and is a list of verbs. It would pass every content screen in
    this file, because it says nothing, and it would help nobody.
    """
    if any(step.role or step.landmark for step in skill.steps):
        return Screen("navigable", True)
    return Screen(
        "navigable",
        False,
        "no step names a role or a landmark: this is a list of calls rather"
        " than a route somebody else could follow",
    )


def _carries_nothing_it_read(rendered: str) -> Screen:
    found = scan(rendered)
    if not found:
        return Screen("content-free", True)
    return Screen(
        "content-free",
        False,
        "the published text carries " + ", ".join(found),
    )
