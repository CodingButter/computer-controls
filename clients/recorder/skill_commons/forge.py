"""Where a candidate skill is proposed: a branch, two files, a pull request.

The episode recorder has a board with three methods, and its docstring says why:
a board that could do more would be a board the filer could be talked into doing
more with. The same ruling applies here and produces a different shape, because
a skill is not an issue. An issue is a sentence on somebody's tracker; a skill is
a *file in the repository*, and the way a file arrives in a repository somebody
else owns is a pull request.

That difference is the entire security argument for this design. An agent cannot
put a skill into the commons. It can open a request that one be put there, and
what admits it is a person reading two files. The word for that in the
distribution ruling is a curated registry — a quality bar, the way an app store
is, not a wall — and the mechanism is that publishing and admitting are two
different verbs performed by two different parties.

`git` and `gh` are driven as subprocesses through one injectable runner, as
`store.py` and `board.py` already do. What a test can prove without a network is
that the argument list says what we meant, and that is the half that goes wrong:
a push to the wrong branch, a base that is not the default, a pull request whose
head nobody set. What it cannot prove is that GitHub accepts it.

Nothing here creates a label, merges anything, or approves anything. There is no
method on this class that closes the loop, and the absence is the point: a forge
that could merge would be a forge somebody would eventually have merge.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .registry import write_pair
from .skill import Skill

#: Where in the repository the commons lives. One folder, in the tree, rather
#: than a repository of its own: end users install from a release and never see
#: a checkout, so a folder they do not download costs them nothing, and a skill
#: that lives beside the code it drives is a skill whose history is the code's.
SKILLS_DIR = "skills"

#: What a submission branch is called. Prefixed so that the branches a machine
#: opens are one `git branch --list` away from being seen all at once.
BRANCH_PREFIX = "skill/"


class ForgeError(RuntimeError):
    """The forge refused, carrying what it said rather than a return code."""


class Forge(Protocol):
    """What a curator needs from wherever skills are proposed."""

    def open_requests(self) -> set[int]:
        """The numbers of this machine's proposals that are still open."""

    def propose(self, skill: Skill, *, base: str) -> int:
        """Open a request that this skill be admitted, and answer with its number."""

    def withdraw(self, number: int, reason: str) -> None:
        """Close one of this machine's own proposals, saying why."""


@dataclass
class GitHubForge:
    """The real forge, reached through the two commands everybody already has.

    `checkout` is a working copy of the repository the commons lives in.
    `submitter` is the installation this machine publishes under — a
    pseudonymous id, not a person: it is what makes one machine's proposals its
    own, so that two machines proposing against the same repository do not spend
    each other's allowance and neither can withdraw the other's work, and it is
    what a maintainer would cut off if a machine started proposing poison. It
    identifies the source without identifying the user, which is the whole of
    what the commons needs to know about either.
    """

    repo: str
    checkout: Path
    submitter: str
    run: Any = None

    # -- the two commands -----------------------------------------------

    def _git(self, *args: str) -> str:
        return self._run("git", "-C", str(self.checkout), *args)

    def _gh(self, *args: str) -> str:
        return self._run("gh", *args)

    def _run(self, *argv: str) -> str:
        run = self.run or _subprocess_runner
        code, out, err = run(argv)
        if code != 0:
            raise ForgeError(f"{' '.join(argv)} failed: {(err or out).strip()}")
        return out.strip()

    # -- the three questions --------------------------------------------

    def open_requests(self) -> set[int]:
        # Matched on the body trailer rather than on the author, for the reason
        # the recorder's board gives: the author of anything opened through
        # `gh` is whoever's token is installed, which is one account for every
        # machine using it. The trailer is the only thing that says which.
        found = self._gh(
            "pr",
            "list",
            "--repo",
            self.repo,
            "--state",
            "open",
            "--search",
            f'"proposed-by {self.submitter}" in:body',
            "--json",
            "number",
            "--limit",
            "100",
        )
        if not found:
            return set()
        return {int(entry["number"]) for entry in json.loads(found)}

    def propose(self, skill: Skill, *, base: str = "main") -> int:
        branch = BRANCH_PREFIX + skill.name

        # From the base every time, never from whatever the checkout happened
        # to be on. A proposal branched off another proposal carries the other
        # one's skill into this one's review, and a reviewer approving two
        # skills while reading one is the failure this whole gate is for.
        self._git("fetch", "origin", base)
        self._git("switch", "--force-create", branch, f"origin/{base}")

        folder = self.checkout / SKILLS_DIR
        document, review = write_pair(folder, skill)
        self._git("add", f"{SKILLS_DIR}/{skill.name}")
        self._git("commit", "--message", _commit_message(skill))
        self._git("push", "--force-with-lease", "--set-upstream", "origin", branch)

        answered = self._gh(
            "pr",
            "create",
            "--repo",
            self.repo,
            "--base",
            base,
            "--head",
            branch,
            "--title",
            _title(skill),
            "--body",
            _body(skill, submitter=self.submitter),
        )
        assert document.exists() and review.exists()
        return _number_in(answered)

    def withdraw(self, number: int, reason: str) -> None:
        self._gh(
            "pr",
            "close",
            str(number),
            "--repo",
            self.repo,
            "--comment",
            reason,
            "--delete-branch",
        )


def _title(skill: Skill) -> str:
    return (
        f"skill: {skill.app.replace('-', ' ')} —"
        f" {skill.task.replace('-', ' ')}"
    )


def _commit_message(skill: Skill) -> str:
    """What the commit says, assembled rather than written.

    Same rule as everything else that leaves the machine: a template over
    enumerated fields, because a commit message an agent can compose is a commit
    message an agent can be talked into composing.
    """
    return (
        f"skill({skill.app}): {skill.task.replace('-', ' ')}\n"
        "\n"
        f"A route derived on one machine and verified {skill.verification.successes}"
        f" times against {skill.app.replace('-', ' ')}"
        f" {skill.verification.app_version}, proposed for the commons.\n"
        "\n"
        f"Skill-Signature: {skill.signature}\n"
    )


def _body(skill: Skill, *, submitter: str) -> str:
    """What a reviewer sees before they open either file.

    Deliberately not a summary of the skill. A summary is an argument, and a
    reviewer who has read a persuasive argument for a poisoned skill has been
    prepared to approve it. This says what the submission *is*, where the two
    files are, and what the reviewer is being asked to decide — and it leaves
    the deciding to the files.
    """
    lines = [
        f"A skill proposed for the commons by installation `{submitter}`.",
        "",
        "This is a **pair**, and both halves are meant to be read:",
        "",
        f"- `{SKILLS_DIR}/{skill.name}/SKILL.md` — the route, as the agent that"
        " follows it will read it.",
        f"- `{SKILLS_DIR}/{skill.name}/REVIEW.md` — what the route has an agent"
        " do, and the evidence for each step.",
        "",
        "## What was already screened",
        "",
        "Every method, role and landmark passed a shape check; the rendered text"
        " carried no address, telephone number, payment card, link or"
        " key-shaped string; the application is not one whose contents the"
        " desktop service withholds; and the route completed"
        f" {skill.verification.successes} distinct times before it was proposed.",
        "",
        "## What is being asked of you",
        "",
        "Whether each landmark in `REVIEW.md` is a fixed part of that"
        " application's interface or a word that was on the screen that day —"
        " no pattern can tell those apart — and whether the route goes"
        " somewhere an agent following it should be going. A step the review"
        " cannot justify is not a step that needs explaining; it is a finding.",
        "",
        "Merging this publishes the route to every machine that pulls the"
        " commons. Nothing here executes: the commons carries procedures, never"
        " scripts and never binaries.",
        "",
        f"proposed-by {submitter}",
        f"skill {skill.signature}",
    ]
    return "\n".join(lines) + "\n"


def _number_in(url: str) -> int:
    """The number out of what `gh pr create` prints, which is a URL."""
    tail = url.strip().rstrip("/").rsplit("/", 1)[-1]
    if not tail.isdigit():
        raise ForgeError(
            f"proposed, but the forge answered with no number: {url!r}"
        )
    return int(tail)


def _subprocess_runner(argv: Sequence[str]) -> tuple[int, str, str]:
    done = subprocess.run(argv, capture_output=True, text=True)
    return done.returncode, done.stdout, done.stderr
