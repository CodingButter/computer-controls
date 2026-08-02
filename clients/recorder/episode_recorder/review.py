"""Reading somebody else's episode, and saying something about a step of it.

A review here is not a score. A number out of ten tells the agent that wrote the
episode nothing it can act on, and tells the next reader nothing about what was
actually wrong. A review is what a review is on a pull request: a remark
attached to a specific step, with the diff of that step beside it.

Remarks are git notes rather than extra commits. A note attaches to a commit
without rewriting it, which is the property that matters — the episode is a
record of what happened, and a reviewer who could edit it would be editing the
past. The reviewer's identity is on the note, so a note is as attributable as a
commit.

The conclusion goes further than a remark. It lands as a proposed change to the
acting agent's own files — a diff against `agent/instructions.md`, on its own
branch, for somebody to merge or not. A lesson written as a comment has to be
read and agreed with and then applied by hand; a lesson written as a diff is
already the shape of the thing that would fix it. That is what makes the agents
improve the way the repository does: propose, review, merge.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .store import Author, Store

NOTES_REF = "refs/notes/reviews"


@dataclass(frozen=True)
class Step:
    """One recorded action, as a reader of the episode meets it."""

    number: int
    commit: str
    intent: str
    record: dict[str, Any]

    @property
    def method(self) -> str:
        return self.record.get("method", "")


class Review:
    """A second agent reading an episode it did not perform."""

    def __init__(self, path, reviewer: Author) -> None:
        self.store = Store(path)
        self.reviewer = reviewer

    def steps(self, branch: str) -> list[Step]:
        """Every step of an episode, oldest first, with its commit.

        The head commit — the declaration and the agent's files — is not a step
        and is not listed as one. It is read with `agent_files`.
        """
        listed = self.store.git(
            "log", "--reverse", "--format=%H%x00%s", self.store.range(branch)
        )
        found: list[Step] = []
        for line in listed.splitlines():
            if not line:
                continue
            commit, _, subject = line.partition("\0")
            names = self.store.git(
                "show", "--name-only", "--format=", commit
            ).splitlines()
            step_files = [name for name in names if name.startswith("steps/")]
            if not step_files:
                continue
            record = json.loads(self.store.git("show", f"{commit}:{step_files[0]}"))
            found.append(
                Step(
                    number=record["step"],
                    commit=commit,
                    intent=record.get("intent", subject),
                    record=record,
                )
            )
        return found

    def diff(self, commit: str) -> str:
        """What that one step changed, which is what the reviewer is judging."""
        return self.store.git("show", "--format=", commit)

    def agent_files(self, branch: str) -> dict[str, str]:
        listed = self.store.git("ls-tree", "-r", "--name-only", branch).splitlines()
        return {
            name: self.store.git("show", f"{branch}:{name}")
            for name in listed
            if name.startswith("agent/")
        }

    def remark(self, step: Step, text: str) -> None:
        """Attach a comment to that step and no other."""
        self.store.git(
            "notes",
            f"--ref={NOTES_REF}",
            "append",
            "--message",
            text,
            step.commit,
            author=self.reviewer,
        )

    def remarks(self, step: Step) -> str:
        return self.store.git(
            "notes", f"--ref={NOTES_REF}", "show", step.commit, check=False
        )

    def propose(self, branch: str, instructions: str, why: str) -> str:
        """Offer the acting agent a change to its own instructions.

        Branched from the episode being reviewed, so the proposal arrives with
        the evidence attached: whoever reads it can see the work that prompted
        it in the same history.
        """
        name = f"review/{branch}"
        self.store.checkout(branch)
        self.store.start_branch(name, at=branch)
        self.store.write(
            "agent/instructions.md",
            instructions if instructions.endswith("\n") else instructions + "\n",
        )
        commit = self.store.commit(why, self.reviewer)
        self.store.checkout("main")
        return commit
