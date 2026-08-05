"""A route one agent derived, in a shape that cannot carry what it saw.

A skill is a *procedure*, not a fact. "Discord is at process 4821" is true for
an hour; "the private messages are behind a `Private channels` landmark, and the
newest one is the last `log` entry under the selected channel" is true until the
application is redesigned. The first is worth nothing to anybody else; the
second is the thing a second agent on a second machine would otherwise spend a
fifty-node accessibility tree rediscovering.

Which is why this file exists and why it is written the way `finding.py` is
written. A skill leaves the machine. It is committed to a public repository, it
is indexed, and it is there forever — so the rule is the same as the one
governing a filed issue, and it is enforced the same way: **a skill carries no
prose**. There is no field an authoring agent can write a sentence into. The
description and the instruction body of the published `SKILL.md` are generated
in `render.py`, from enumerated fields, by a template — because a registry that
can be handed a sentence is a registry that can be handed a password, and no
amount of scanning the sentence afterwards fixes that.

What an agent supplies is which application, which task, and an ordered list of
steps; each step is a protocol method, optionally the role of the element it
acts on, and optionally the *landmark* that names where in the tree to look.

The landmark is where the honesty in this file has to live. Everything else is
held to a shape or a closed vocabulary and cannot admit content: a method is a
camelCase identifier, a role is one of twenty-nine words the accessibility layer
uses, a version is digits and dots. A landmark cannot be either of those things,
because the vocabulary is different in every application and a route without one
is a route to nowhere. It is held to a shape — letters, at most three words, no
digits, no punctuation a sentence needs — and that shape refuses a message, a
sentence, a password and an address.

It does not refuse `Alice Nichols`, and this file does not pretend otherwise.
That is precisely why a submission is a **pair**: the skill, and a review that
has to justify every landmark in it. A landmark whose justification is missing
is not a landmark somebody forgot to explain, it is a finding. The screens in
`validator.py` narrow what a human has to read; they do not replace the human,
and a comment claiming they did would be the most dangerous line in the package.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field, replace
from typing import Any

from episode_recorder.finding import HANDLE, METHOD, ROLES
from episode_recorder.store import Author

#: How many distinct times a route must have worked before it is a skill. The
#: recurrence bar the episode recorder already applies to findings, for the same
#: reason: a route derived once is a candidate, a route derived twice is a
#: skill. One success is as easily an accident as a procedure.
BAR = 2

#: An application or task is named as a slug, because the published skill's
#: directory is named after it and the Agent Skills specification wants a name
#: of lower-case letters, digits and hyphens. It is also the cheapest possible
#: content check: nothing read off a screen survives being lower-cased,
#: de-punctuated and hyphen-joined by an agent that was never given the chance.
SLUG = re.compile(r"\A[a-z][a-z0-9]*(-[a-z0-9]+)*\Z")

#: A version string, as an application reports it. Digits and dots, with an
#: optional suffix, because that is what a version is and it is not a sentence.
VERSION = re.compile(r"\A[0-9]+(\.[0-9]+){0,3}([-+][A-Za-z0-9.]{1,16})?\Z")

#: A date, as a date. Not a free-form "when this was last checked".
WHEN = re.compile(r"\A[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")

#: What a step may say about where to look. Letters, spaces, ampersands,
#: slashes and hyphens; at most three words; nothing else. That refuses a
#: sentence, a message, an address, a key and a password — every shape whose
#: absence can be proved. It admits a person's name, which is the thing it
#: cannot prove and the reason a human reads the review before this is merged.
LANDMARK = re.compile(r"\A[A-Za-z][A-Za-z&/-]*( [A-Za-z&/-]+){0,2}\Z")

#: The longest a landmark may be. A label on a piece of application chrome is
#: short; a label that is not short is usually a piece of content wearing one.
LANDMARK_LIMIT = 48

#: What an amendment did to a step. A closed list, because "what changed" is
#: exactly the field an agent would otherwise write a paragraph into, and the
#: paragraph would be about what it saw.
AMENDMENTS: dict[str, str] = {
    "step-added": "a step the route did not used to need",
    "step-removed": "a step the route no longer needs",
    "landmark-moved": "the same element, found under a different landmark",
    "role-changed": "the same element, reported with a different role",
    "method-changed": "the same step, taken through a different call",
}


class NotPublishable(ValueError):
    """A skill refused before it could become a file in a public repository.

    Raised rather than sanitised, for the reason `finding.py` gives: a skill
    that quietly dropped the field it was refused for would publish a route
    missing the step its author thought was in it, and nobody would be told.
    """


def _shaped(what: str, value: str, pattern: re.Pattern[str]) -> None:
    if value and not pattern.fullmatch(value):
        raise NotPublishable(
            f"not a {what} this package will publish: {value!r}. "
            "A skill carries structure, never anything read off the screen."
        )


@dataclass(frozen=True)
class Step:
    """One move in a route, named by what it calls and where it looks.

    `method` is a protocol call — `census`, `setAttention`, `describeElement`.
    `role` is what the accessibility layer calls the element, held to the same
    closed vocabulary the recorder's findings use. `landmark` is the label to
    navigate by, and it is the only field here that carries a word the
    application chose.

    There is deliberately no element id. An id is a handle issued for one
    session; a route that named one would be a route that worked exactly once,
    on one machine, and would look like a route that worked.
    """

    ordinal: int
    method: str
    role: str = ""
    landmark: str = ""

    def __post_init__(self) -> None:
        if self.ordinal < 1:
            raise NotPublishable(f"not a step number: {self.ordinal}")
        if not self.method:
            raise NotPublishable("a step with no call is not a step")
        _shaped("method", self.method, METHOD)
        if self.role and self.role not in ROLES:
            raise NotPublishable(
                f"not a role the accessibility layer uses: {self.role!r}"
            )
        if self.landmark:
            if len(self.landmark) > LANDMARK_LIMIT:
                raise NotPublishable(
                    f"too long to be a landmark, at {len(self.landmark)} characters:"
                    f" {self.landmark!r}. A label on a piece of chrome is short;"
                    " a label that is not short is usually content wearing one."
                )
            _shaped("landmark", self.landmark, LANDMARK)


@dataclass(frozen=True)
class Amendment:
    """A recorded revision to a route, with what it was checked against.

    A skill that can only rot is worse than no skill: it becomes the stale
    belief problem with better formatting. So amending is first class, and an
    amendment says which step moved, in which direction, and against which
    version of the application it was re-derived.
    """

    kind: str
    step: int
    app_version: str
    when: str

    def __post_init__(self) -> None:
        if self.kind not in AMENDMENTS:
            raise NotPublishable(f"not a kind of amendment: {self.kind!r}")
        if self.step < 1:
            raise NotPublishable(f"not a step number: {self.step}")
        _shaped("version", self.app_version, VERSION)
        _shaped("date", self.when, WHEN)
        if not self.app_version or not self.when:
            raise NotPublishable(
                "an amendment with no version and date is an amendment nobody"
                " can tell is stale"
            )


@dataclass(frozen=True)
class Verification:
    """What lets a reader decide how much to trust this route.

    An application's version and the date the route last worked are the
    staleness signal: `verified against Discord 1.0.151` is a claim a reader can
    check against the Discord they have. `successes` is how many distinct times
    the route completed — the recurrence count that got it over the bar.
    """

    app_version: str
    when: str
    successes: int = BAR

    def __post_init__(self) -> None:
        _shaped("version", self.app_version, VERSION)
        _shaped("date", self.when, WHEN)
        if not self.app_version:
            raise NotPublishable(
                "a route verified against no version is a route nobody can tell"
                " is stale"
            )
        if not self.when:
            raise NotPublishable("a route verified on no date is a route unchecked")
        if self.successes < 1:
            raise NotPublishable(f"not a count of successes: {self.successes}")


@dataclass(frozen=True)
class Skill:
    """A route, reduced to what may leave the machine that derived it."""

    app: str
    task: str
    steps: tuple[Step, ...]
    verification: Verification
    author: Author
    amendments: tuple[Amendment, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        _shaped("application", self.app, SLUG)
        _shaped("task", self.task, SLUG)
        if not self.app or not self.task:
            raise NotPublishable("a skill is named for an application and a task")
        if not self.steps:
            raise NotPublishable("a route with no steps is not a route")
        ordinals = [step.ordinal for step in self.steps]
        if ordinals != list(range(1, len(ordinals) + 1)):
            raise NotPublishable(
                f"steps are numbered from one, in order: {ordinals}"
            )
        _shaped("agent label", self.author.label, HANDLE)
        _shaped("agent id", self.author.client_id, HANDLE)

    # -- identity -------------------------------------------------------

    @property
    def name(self) -> str:
        """The published directory name, per the Agent Skills specification.

        Assembled from the two slugs rather than supplied, so that the one
        string a reader sees first is one no agent typed.
        """
        return f"{self.app}-{self.task}"

    @property
    def signature(self) -> str:
        """What makes two derivations the same route rather than two routes.

        The methods, roles and landmarks in order — never the element ids,
        which name one session, and never the author, because the same route
        found twice by two agents is one skill with two witnesses.
        """
        parts = [self.app, self.task]
        for step in self.steps:
            parts += [step.method, step.role, step.landmark]
        return hashlib.sha256("\x00".join(parts).encode()).hexdigest()[:16]

    @property
    def landmarks(self) -> tuple[str, ...]:
        """Every application-supplied word in this skill, in one place.

        The review has to justify each of these and a human has to read them.
        Collecting them here is what makes "every landmark was accounted for" a
        question with an answer rather than a reading exercise.
        """
        seen: list[str] = []
        for step in self.steps:
            if step.landmark and step.landmark not in seen:
                seen.append(step.landmark)
        return tuple(seen)

    @property
    def over_the_bar(self) -> bool:
        return self.verification.successes >= BAR

    def amended(self, amendment: Amendment, steps: tuple[Step, ...],
                verification: Verification) -> "Skill":
        """The same skill, revised, with the revision on the record.

        The amendment is appended rather than replacing anything, because a
        skill whose history can be rewritten is a skill whose history is a
        summary. Git would catch it anyway; carrying it in the file means a
        reader who has the file has the history without the repository.
        """
        return replace(
            self,
            steps=steps,
            verification=verification,
            amendments=self.amendments + (amendment,),
        )


def as_document(skill: Skill) -> dict[str, Any]:
    """The skill as it is written into a ledger or a frontmatter block."""
    return {
        "name": skill.name,
        "signature": skill.signature,
        "app": skill.app,
        "task": skill.task,
        "author": {"clientId": skill.author.client_id, "label": skill.author.label},
        "verification": {
            "appVersion": skill.verification.app_version,
            "when": skill.verification.when,
            "successes": skill.verification.successes,
        },
        "steps": [
            {
                "ordinal": step.ordinal,
                "method": step.method,
                "role": step.role,
                "landmark": step.landmark,
            }
            for step in skill.steps
        ],
        "amendments": [
            {
                "kind": a.kind,
                "step": a.step,
                "appVersion": a.app_version,
                "when": a.when,
            }
            for a in skill.amendments
        ],
    }


def from_document(document: dict[str, Any]) -> Skill:
    verification = document["verification"]
    return Skill(
        app=document["app"],
        task=document["task"],
        steps=tuple(
            Step(
                ordinal=step["ordinal"],
                method=step["method"],
                role=step.get("role", ""),
                landmark=step.get("landmark", ""),
            )
            for step in document["steps"]
        ),
        verification=Verification(
            app_version=verification["appVersion"],
            when=verification["when"],
            successes=verification.get("successes", BAR),
        ),
        author=Author(
            client_id=document["author"]["clientId"],
            label=document["author"].get("label", ""),
        ),
        amendments=tuple(
            Amendment(
                kind=a["kind"],
                step=a["step"],
                app_version=a["appVersion"],
                when=a["when"],
            )
            for a in document.get("amendments", [])
        ),
    )
