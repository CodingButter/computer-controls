"""The gate: the one way a skill can reach the forge, and the record of the ones that didn't.

Everything before this file can be assembled independently — a skill can be
built, a skill can be rendered, a forge can be handed a skill and will propose
it. This is where those become one path, and the point of it is that there is
only one. A machine that could reach the forge two ways would eventually reach
it the way that skips the screens.

Four rules, and the second is the one that took the longest to see.

**Screen before send, not after.** The screens run on this machine, before a
branch exists. The service's send gate makes the same ruling about text an agent
wants to type — it is verified while it can still be refused — and a screen that
ran on a server would be a screen that ran after the thing it was screening had
already left.

**The refusals are the half worth keeping.** The audit log records refusals as
carefully as it records actions, and its docstring says why: an action that
happened is a thing you can see in the world, and a refusal is a thing you can
see nowhere else. A gate that recorded only what it admitted would answer "how
often does this refuse" with silence, and a screen nobody can see working is a
screen nobody will notice has stopped.

**The record cannot quote what it refused.** This is the trap, and the recorder's
filing tests are the reason it is visible: a filer that quoted the record it was
reading would pass every test written against the redaction policy and still put
a stranger's name on the internet. A gate that logged *"refused: found the
address 12 Rowan Street"* would take the one thing that must not be published
and write it somewhere permanent, helpfully, in the name of an audit trail. So a
refusal records what the screen was called and what shape it found — an
enumerated phrase from the screen's own vocabulary — and never the text that
matched. Being unable to reconstruct the offending value from the log is the
property, not a limitation of it.

**Nothing is proposed without a review beside it.** The screens above are
patterns, and the questions that decide whether a route should leave this
machine are not questions a pattern can be asked: is any of this somebody's
name, would following it hurt the person who did, is it a route at all or one
installation's furniture written down. So the last thing before the forge is a
reader — `reviewer.py` — handed the bytes that would be committed. Its two
failure modes are kept apart on purpose: a reader that objected is a refusal
about the skill, and a reader that never answered is an absence, which is not an
objection and is not a pass either. There is no flag past either one. An
override would make every sentence above it decorative.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from .forge import Forge
from .render import render, render_review
from .reviewer import Panel, Review, Unobtainable
from .skill import Skill
from .validator import Screen, Verdict, validate

#: Off unless it is switched on, read as set-or-not rather than parsed for a
#: value. The same shape as the recorder's filing switch and the service's
#: presence flag, because a machine that publishes by default is a machine that
#: published before anybody decided it should.
SUBMISSION_ENV = "DESKTOP_SKILL_SUBMISSION"

#: How many proposals one installation may have open at once. The recorder caps
#: filings for the same reason and states it plainly: at the cap the machine
#: stays quiet or withdraws its own weakest, so triage happens at the source
#: rather than in a maintainer's inbox.
CAP = 3

#: The screen that carries whether a reader objected, and the screen that
#: carries whether there was a reader at all. Two names rather than one, because
#: they are two different things that both stop a publication and only one of
#: them is about the skill. A machine whose credential expired refuses
#: everything; a machine whose routes are bad refuses everything; a ledger with
#: one name in it could not tell the operator which had happened.
REVIEW_SCREEN = "review"
OBTAINED_SCREEN = "review-obtained"


def screen(skill: Skill) -> Verdict:
    """Every screen, run against both the structure and the published text.

    The rendered pair is what a reviewer and every consuming machine will
    actually read, so it is what the content screen reads. Screening the
    dataclass and publishing the document would be screening one thing and
    shipping another.

    This is a function rather than a method because there is more than one
    destination a skill can be offered to — a proposal this machine opens
    itself, and a person pressing publish against the project's service — and
    the rule at the top of this file is about the *gate*, not about the
    forge. Two callers of one screening function is one gate; two callers each
    assembling their own screens is how the second one ends up missing the
    screen that was added last.
    """
    return validate(skill, rendered=render(skill) + "\n" + render_review(skill))


class Refused(RuntimeError):
    """The gate said no. Carries the screens, never what they matched on."""

    def __init__(self, verdict: Verdict) -> None:
        super().__init__(verdict.reason)
        self.verdict = verdict


@dataclass(frozen=True)
class Submission:
    """What the gate decided, whether or not anything was sent.

    Answered for admissions *and* refusals, and for the case where the machine
    was never switched on — the recorder's filer does the same, and its reason
    holds here: the interesting cases are the ones where nothing happened, and
    a function that returns nothing when it does nothing cannot be watched.
    """

    skill: str
    admitted: bool
    proposed: int | None
    screens: tuple[Screen, ...]
    reason: str

    @property
    def refusals(self) -> tuple[Screen, ...]:
        return tuple(screen for screen in self.screens if not screen.passed)


class Ledger:
    """Every decision this gate made, in a file only this machine reads.

    Line-delimited JSON at the state path, 0600, appended to — the audit log's
    shape, for the audit log's reasons. A write that fails is counted and does
    not raise: losing the record must not lose the decision, and a gate that
    crashed because it could not write a log would be a gate that fails open in
    the one direction that matters.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.unwritten = 0

    def record(self, submission: Submission) -> None:
        record = {
            "version": 1,
            "skill": submission.skill,
            "admitted": submission.admitted,
            "proposed": submission.proposed,
            # The screen's name and its own words for the shape it found. Never
            # the value, never the rendered text, never the landmark. What was
            # refused is not reconstructable from this file, and that is the
            # reason the file is safe to keep.
            "screens": [
                {"name": screen.name, "passed": screen.passed}
                for screen in submission.screens
            ],
            "refused_for": [screen.name for screen in submission.refusals],
        }
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(
                os.open(
                    self.path,
                    os.O_WRONLY | os.O_CREAT | os.O_APPEND,
                    0o600,
                ),
                "w",
                encoding="utf-8",
            ) as sink:
                sink.write(json.dumps(record, sort_keys=True) + "\n")
        except OSError:
            self.unwritten += 1

    def read(self) -> tuple[dict, ...]:
        if not self.path.exists():
            return ()
        return tuple(
            json.loads(line)
            for line in self.path.read_text().splitlines()
            if line.strip()
        )


class Curator:
    """The only path from a derived route to a proposal.

    `enabled` is read from the environment once at construction rather than at
    every call, so that the answer to "does this machine publish" is a property
    of the process rather than something that can change underneath a decision
    half-made.
    """

    def __init__(
        self,
        forge: Forge,
        ledger: Ledger,
        *,
        panel: Panel | None = None,
        cap: int = CAP,
        enabled: bool | None = None,
        environ: dict[str, str] | None = None,
        base: str = "main",
    ) -> None:
        self.forge = forge
        self.ledger = ledger
        # A curator built without a panel is a curator that publishes nothing.
        # Not an error at construction — the machine is still allowed to derive
        # and screen routes and record what it decided — but a review it cannot
        # obtain is a review it did not have, and that is where it stops. The
        # default that would have been convenient here is the one that publishes.
        self.panel = panel or Panel()
        self.cap = cap
        self.base = base
        if enabled is None:
            enabled = SUBMISSION_ENV in (
                environ if environ is not None else os.environ
            )
        self.enabled = enabled

    def screen(self, skill: Skill) -> Verdict:
        """The gate, as this curator asks it. See `screen` above."""
        return screen(skill)

    def review(self, skill: Skill) -> Review:
        """Put the published bytes in front of the panel, or raise `Unobtainable`.

        `render(skill)` and not a summary and not the dataclass: the bytes a
        reader is handed are the bytes that would be committed, because a review
        of anything else is a review of something that is not being published.
        """
        return self.panel.read(render(skill))

    def submit(self, skill: Skill) -> Submission:
        """Screen a skill and, if it passes and this machine publishes, propose it.

        Always answers, never raises for a refusal. A refusal is an outcome of
        this function, not an error in it — the caller asked whether this route
        could be published and "no, and here is which screen said so" is the
        answer to that question.
        """
        verdict = self.screen(skill)
        if not verdict.admitted:
            return self._record(
                skill, verdict, proposed=None, reason=verdict.reason
            )

        if not self.enabled:
            return self._record(
                skill,
                verdict,
                proposed=None,
                reason=(
                    "this machine does not publish: screened and recorded, so"
                    f" the gate can be watched before it is trusted (set"
                    f" {SUBMISSION_ENV} to publish)"
                ),
            )

        open_now = self.forge.open_requests()
        if len(open_now) >= self.cap:
            return self._record(
                skill,
                verdict,
                proposed=None,
                reason=(
                    f"{len(open_now)} proposals from this installation are"
                    f" already open and the cap is {self.cap}: a machine that"
                    " kept proposing would be triaged by whoever reads the"
                    " queue rather than by the machine that filled it"
                ),
            )

        # Last, and only on a machine that publishes. The screens above are
        # patterns and cost nothing; a review is a model reading a document, and
        # a machine with nowhere to send a skill has nothing to gate. What it
        # must never be is skipped on the path that does send one.
        try:
            read_by = self.review(skill)
        except Unobtainable as absent:
            return self._record(
                skill,
                verdict,
                proposed=None,
                reason=(
                    f"no review could be obtained, which is not the same as no"
                    f" objection: {absent}. Silence is not consent, so nothing"
                    " has been proposed"
                ),
                extra=(Screen(OBTAINED_SCREEN, False, "no reader answered"),),
            )

        if not read_by.passed:
            return self._record(
                skill,
                verdict,
                proposed=None,
                reason=read_by.reason,
                extra=(
                    Screen(OBTAINED_SCREEN, True),
                    Screen(REVIEW_SCREEN, False, "a reader objected"),
                ),
            )

        number = self.forge.propose(skill, read_by=read_by, base=self.base)
        return self._record(
            skill,
            verdict,
            proposed=number,
            reason="",
            extra=(Screen(OBTAINED_SCREEN, True), Screen(REVIEW_SCREEN, True)),
        )

    def _record(
        self,
        skill: Skill,
        verdict: Verdict,
        *,
        proposed: int | None,
        reason: str,
        extra: tuple[Screen, ...] = (),
    ) -> Submission:
        screens = verdict.screens + extra
        submission = Submission(
            skill=skill.name,
            admitted=all(screen.passed for screen in screens)
            and proposed is not None,
            proposed=proposed,
            screens=screens,
            reason=reason,
        )
        self.ledger.record(submission)
        return submission


def refusals_in(ledger: Ledger) -> Iterable[dict]:
    """The decisions that were noes, for anybody asking how often this refuses."""
    return (record for record in ledger.read() if not record["admitted"])
