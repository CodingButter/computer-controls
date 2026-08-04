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

from .episode import ID_TRAILER
from .finding import Finding, Occurrence
from .store import UNLABELLED, Author, Store, StoreError

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

    def declaration(self, branch: str) -> str:
        """The commit an episode opened with: the brief, not a step."""
        listed = self.store.git(
            "log", "--reverse", "--format=%H", self.store.range(branch)
        ).splitlines()
        if not listed:
            raise StoreError(f"{branch} has no commits of its own to be opened by")
        return listed[0]

    def episode_id(self, branch: str) -> str:
        """What this episode is called when it is spoken about elsewhere.

        Read off the opening commit rather than recomputed, so a reader and a
        writer cannot disagree about it. This is what a finding uses to say
        "these were two different episodes" without saying what either of them
        was called.
        """
        body = self.store.git("log", "-1", "--format=%B", self.declaration(branch))
        for line in body.splitlines():
            name, _, value = line.partition(":")
            if name.strip() == ID_TRAILER and value.strip():
                return value.strip()
        raise StoreError(f"{branch} was opened without an {ID_TRAILER}")

    def find(
        self,
        branch: str,
        step: Step,
        kind: str,
        *,
        role: str = "",
        tool: str = "",
        area: str = "area:client",
        needs_desktop: bool = False,
    ) -> Finding:
        """A conclusion about one step, in the only shape that can be filed.

        What the step did — the method, the element it named, how it failed — is
        read out of the record rather than accepted from the reviewer. The
        record went through the allowlist when it was written, so a finding
        built from it inherits that guarantee instead of restating it, and a
        reviewer cannot describe the step as something other than what happened.

        Who it is filed against is read from the commit, for the same reason: an
        episode's author is the identity the service issued at the handshake,
        and a reviewer naming the agent by hand could name the wrong one.
        """
        record = step.record
        return Finding(
            kind=kind,
            agent=self.author_of(step.commit),
            occurrences=(
                Occurrence(
                    episode=self.episode_id(branch),
                    step=step.number,
                    commit=step.commit,
                ),
            ),
            method=record.get("method", ""),
            target=record.get("target", ""),
            error=(record.get("error") or {}).get("code", ""),
            role=role,
            tool=tool,
            area=area,
            needs_desktop=needs_desktop,
        )

    def author_of(self, commit: str) -> Author:
        """The identity a commit was made under, back as the Author it came from."""
        line = self.store.git("log", "-1", "--format=%an%x00%ae", commit)
        label, _, email = line.partition("\0")
        # A client that sent no label is committed under a stand-in sentence
        # rather than a name. Reading it back as a label would be treating the
        # absence of a claim as a claim.
        return Author(
            client_id=email.split("@", 1)[0],
            label="" if label == UNLABELLED else label,
        )

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
