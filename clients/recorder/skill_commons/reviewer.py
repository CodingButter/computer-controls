"""The second reader: a model that answers three questions about the bytes.

The screens in `validator.py` are patterns, and a pattern is honest about what
it cannot do. It can prove a card number is absent. It cannot tell `Private
channels` from `Alice Nichols`, it cannot tell a route that deletes something
from one that reads something, and it cannot tell a procedure from one machine's
furniture written down. Those are the three questions that decide whether a
skill should leave the machine that learned it, and none of them is a question a
regular expression can be written for.

So a skill derived here is read by something that reads, before it is proposed
anywhere. Not to replace the person who merges it — the forge still cannot merge
and this file adds no method that can — but because a route published without
anybody having read it is a claim about somebody else's machine made on the
strength of it having worked twice on this one.

Four rulings, and the last two are the ones that get quietly broken.

**It reads what will be published.** The reviewer is handed the rendered
`SKILL.md`, byte for byte, and not the dataclass and not a summary of it. A
review of a summary is a review of an argument, which is the same failure the
pull request body is written to avoid.

**A refusal names what it found.** `no` is not actionable and gets worked
around. What the reviewer objected to is carried back to the caller in full —
and never to the ledger, which records screen names and nothing else, because a
refusal that quoted the name it refused would write that name into a permanent
file in the course of protecting it.

**An unobtainable review is not a pass.** A model that is unreachable, a
credential that is absent, a rate limit, an answer in words this gate cannot
read: every one of those is `Unobtainable`, which is a distinct outcome from a
refusal and is not an admission. Silence is not consent, and the failure mode
worth naming is the one where a machine publishes freely for a month because a
key expired and nothing said so.

**There is no override.** No flag, no environment variable, no `force=True`.
A gate with a way past it is a gate whose way past it becomes the way, and every
other sentence here would be decorative.

What is published out of all this is a table of names and yes-or-nos, never the
reviewer's prose. The rule this package applies to skills — generated text over
enumerated fields, because anything that can be handed a sentence can be handed
a password — applies no less to a sentence a language model wrote.
"""

from __future__ import annotations

import json
import re
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

#: What a reviewer may be called. The name is published in `REVIEW.md`, so it
#: is held to a shape for the same reason every other published field is: a
#: field nobody checks is a field somebody eventually writes a sentence into.
REVIEWER = re.compile(r"\A[a-z0-9][a-z0-9.:_-]{0,47}\Z")

#: The only two words this gate understands as an answer. Anything else — an
#: apology, a refusal to answer, an empty string, prose — is not a third verdict
#: and is not a pass; it is a review that was not obtained.
VERDICTS: dict[str, bool] = {"pass": True, "refuse": False}

#: The three questions, and the wording each is asked in. The keys are what a
#: published review is a table of, so they read as properties a skill either has
#: or does not, rather than as faults.
QUESTIONS: tuple[tuple[str, str], ...] = (
    (
        "carries nothing of a person",
        "Does anything in this file name a person, a subject line, an employer,"
        " a path under somebody's home directory, or a hostname on somebody's"
        " network? A route names roles and landmarks. Anything that names a"
        " person or a machine is content that came along for the ride.",
    ),
    (
        "names what it does before it does it",
        "Could an agent following this destroy, send, pay for or delete"
        " something? That is not disqualifying on its own — it is disqualifying"
        " if the route does not say so, because the reader would find out by"
        " running it.",
    ),
    (
        "is a route and not one machine's furniture",
        "Would this work on a machine that is not the one it was derived on? A"
        " route that leans on one installation's window titles, folder layout"
        " or extensions is that machine's configuration with extra steps.",
    ),
)

#: How much of a reviewer's answer is carried back. Bounded because a finding is
#: a sentence from a model and is shown to somebody; a model that answered with
#: a novel should not be able to fill a terminal or a log line with it.
FINDING_LIMIT = 240
FINDINGS_KEPT = 8


class Unobtainable(RuntimeError):
    """No review was had.

    Distinct from a refusal on purpose, and the distinction is the point of the
    class: `refused` means something read this and objected, `unobtainable`
    means nothing read it. Both stop a publication, and a caller that could not
    tell them apart would eventually treat the second as the first and then as
    routine.
    """


@dataclass(frozen=True)
class Opinion:
    """One reviewer's answer about one rendered skill."""

    reviewer: str
    passed: bool
    findings: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not REVIEWER.match(self.reviewer):
            raise ValueError(
                f"{self.reviewer!r} is not a reviewer name this package will"
                " publish: lower-case letters, digits and `.:_-`, at most 48"
            )
        if not self.passed and not self.findings:
            raise ValueError(
                "a refusal names what it found: a reviewer that says no and"
                " nothing else is a reviewer nobody can act on"
            )


class Reviewer(Protocol):
    """Whatever can be handed a rendered skill and will answer for it."""

    name: str

    def read(self, document: str) -> Opinion:
        """Answer for this document, or raise `Unobtainable` having not."""


@dataclass(frozen=True)
class Review:
    """Every reviewer's answer, and whether that adds up to a yes."""

    opinions: tuple[Opinion, ...]

    @property
    def passed(self) -> bool:
        """Every reviewer read it and none of them objected.

        Empty is false rather than vacuously true. `all(())` is the single most
        expensive default in a gate like this one: a panel with no reviewers in
        it would publish everything, quietly, and the code would look correct.
        """
        return bool(self.opinions) and all(
            opinion.passed for opinion in self.opinions
        )

    @property
    def refusals(self) -> tuple[Opinion, ...]:
        return tuple(
            opinion for opinion in self.opinions if not opinion.passed
        )

    @property
    def agreed(self) -> bool:
        """More than one reviewer, saying the same thing.

        Two models agreeing is a stronger signal than one model insisting, and
        it is worth saying out loud on the review rather than leaving a reader
        to count rows.
        """
        return len(self.opinions) > 1 and len(
            {opinion.passed for opinion in self.opinions}
        ) == 1

    @property
    def reviewers(self) -> tuple[str, ...]:
        return tuple(opinion.reviewer for opinion in self.opinions)

    @property
    def findings(self) -> tuple[str, ...]:
        """What was objected to, said by whom. Carried, never published."""
        return tuple(
            f"{opinion.reviewer}: {finding}"
            for opinion in self.refusals
            for finding in opinion.findings
        )

    @property
    def reason(self) -> str:
        if self.passed:
            return ""
        return "the review refused: " + "; ".join(self.findings)


class Panel:
    """The reviewers a machine submits through, asked one after another.

    Every reviewer must answer. A panel that carried on when one of two models
    was unreachable would be a panel that becomes one reviewer without anybody
    being told — and "two reviewers agreed" would go on being printed by a
    machine that had asked one. So an unobtainable answer from any member is an
    unobtainable review, and the caller finds out.
    """

    def __init__(self, *reviewers: Reviewer) -> None:
        self.reviewers = tuple(reviewers)

    def read(self, document: str) -> Review:
        if not self.reviewers:
            raise Unobtainable(
                "no reviewer is configured on this machine: nothing read the"
                " skill, which is not the same as nothing objecting to it"
            )
        return Review(
            opinions=tuple(
                reviewer.read(document) for reviewer in self.reviewers
            )
        )


def ask(document: str) -> str:
    """The three questions, with the bytes under review beneath them."""
    lines = [
        "You are reviewing a procedure that one machine derived and now"
        " proposes to publish to strangers. It is reproduced below exactly as"
        " it would be published. Answer only about what is in it.",
        "",
    ]
    for number, (heading, question) in enumerate(QUESTIONS, start=1):
        lines += [f"{number}. {heading} — {question}", ""]
    lines += [
        "Answer with one JSON object and nothing else:",
        '{"verdict": "pass" | "refuse", "findings": ["..."]}',
        "",
        "`refuse` if the answer to any question above is no. Every finding"
        " names the specific thing you found — the landmark, the step, the"
        " word — because a refusal nobody can act on is a refusal that gets"
        " worked around. If you cannot judge it, refuse and say why.",
        "",
        "--- the skill, as it would be published ---",
        document,
        "--- end of the skill ---",
    ]
    return "\n".join(lines)


@dataclass
class CommandReviewer:
    """A reviewer reached by running a command and reading what it printed.

    The same shape as the forge's runner and for the same reason: a subprocess
    behind one injectable callable is a thing a test can prove the arguments of
    without a network or a credential. `run` is handed the argument list and the
    prompt to write to standard input, and answers `(code, out, err)`.

    Every way this can go wrong that is not a refusal is `Unobtainable`: a
    command that is not installed, a non-zero exit, an empty answer, an answer
    with no JSON in it, a verdict that is not one of the two words. None of
    those is a model saying a skill is fine.
    """

    name: str
    argv: Sequence[str]
    run: Any = None

    def read(self, document: str) -> Opinion:
        run = self.run or _subprocess_runner
        try:
            code, out, err = run(tuple(self.argv), ask(document))
        except OSError as unreachable:
            raise Unobtainable(
                f"`{self.name}` could not be reached: {unreachable}"
            ) from unreachable
        if code != 0:
            raise Unobtainable(
                f"`{self.name}` answered with a failure rather than a review:"
                f" {(err or out).strip()[:FINDING_LIMIT]}"
            )
        return _answer(self.name, out)


def _answer(name: str, printed: str) -> Opinion:
    """What a reviewer said, read strictly, and never read as a yes by accident."""
    found = _object_in(printed)
    if found is None:
        raise Unobtainable(
            f"`{name}` answered in something other than the verdict it was"
            " asked for, so nothing here has been reviewed"
        )
    verdict = str(found.get("verdict", "")).strip().lower()
    if verdict not in VERDICTS:
        raise Unobtainable(
            f"`{name}` answered {verdict!r}, which is not `pass` or `refuse`:"
            " an answer this gate cannot read is not an answer"
        )
    if VERDICTS[verdict]:
        return Opinion(reviewer=name, passed=True)

    findings = _findings(found.get("findings"))
    return Opinion(
        reviewer=name,
        passed=False,
        # A refusal with nothing attached still refuses. The safe direction is
        # never the one that turns a missing field into an admission.
        findings=findings
        or ("refused without naming what it found",),
    )


def _findings(answered: Any) -> tuple[str, ...]:
    if isinstance(answered, str):
        answered = [answered]
    if not isinstance(answered, list):
        return ()
    kept = []
    for finding in answered[:FINDINGS_KEPT]:
        text = str(finding).strip()[:FINDING_LIMIT]
        if text:
            kept.append(text)
    return tuple(kept)


def _object_in(printed: str) -> dict | None:
    """The JSON object a model printed, whatever it wrapped it in.

    Models fence their output, apologise before it and explain after it. This
    reads the outermost braces rather than insisting on a bare document,
    because the alternative — a gate that treats a fenced answer as no answer —
    is a gate somebody would be tempted to give a way past.
    """
    text = printed.strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        found = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return found if isinstance(found, dict) else None


def _subprocess_runner(argv: Sequence[str], prompt: str) -> tuple[int, str, str]:
    done = subprocess.run(argv, input=prompt, capture_output=True, text=True)
    return done.returncode, done.stdout, done.stderr
