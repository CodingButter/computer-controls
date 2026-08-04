"""The issue board, as the thin thing a filer needs it to be.

Three questions and no more: which of my issues are still open, take this one,
and withdraw that one. A board that could do more would be a board the filer
could be talked into doing more with.

`gh` is driven as a subprocess for the same reason `git` is in `store.py` — it
is the tool that is already installed, already authenticated, and already the
thing a person would use by hand to check what the filer did. The command is
built here and run through an injectable runner, so the argument list is
something a test can read without a network, a token or a repository. What
cannot be proved in this suite is that GitHub accepts the command; what can be
proved, and is, is that the command says what we meant.

Nothing here creates a label. The routing labels this board already uses are the
only ones a finding can carry, so filing needs no permission that reading does
not, and a filer cannot invent a taxonomy at three in the morning.

An issue filed with no stage on it lands in Intake, which is where this board
puts anything nobody has triaged yet. That is not something this file arranges;
it is what Intake means, and the filer's job is to arrive there like everybody
else rather than to have a private entrance.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol


class BoardError(RuntimeError):
    """The board refused, carrying what it said rather than a return code."""


class Board(Protocol):
    """What a filer needs from wherever issues live."""

    def open_issues(self) -> set[int]:
        """The numbers of issues this filer opened that are still open."""

    def file(self, *, title: str, body: str, labels: Sequence[str]) -> int:
        """Open an issue, and answer with its number."""

    def withdraw(self, number: int, reason: str) -> None:
        """Close one of this filer's own issues, saying why."""


@dataclass
class GitHubBoard:
    """The real board, reached through the command line everybody already has.

    `filer` is the client id the episodes were recorded under. It goes in the
    body of everything filed as a `filed-by` trailer and it is what the open
    issue search matches on, so one agent's cap is its own: two agents filing
    against the same repository do not spend each other's allowance, and neither
    can withdraw the other's work.
    """

    repo: str
    filer: str
    run: Any = None

    def _gh(self, *args: str) -> str:
        run = self.run or _subprocess_runner
        code, out, err = run(("gh", *args))
        if code != 0:
            raise BoardError(f"gh {' '.join(args)} failed: {(err or out).strip()}")
        return out.strip()

    def open_issues(self) -> set[int]:
        # Matched on the body trailer rather than on the author, because the
        # author of anything filed through `gh` is whoever's token is installed
        # — one machine account for every agent on it. The trailer is the only
        # thing that says which agent.
        found = self._gh(
            "issue",
            "list",
            "--repo",
            self.repo,
            "--state",
            "open",
            "--search",
            f'"filed-by {self.filer}" in:body',
            "--json",
            "number",
            "--limit",
            "100",
        )
        if not found:
            return set()
        return {int(entry["number"]) for entry in json.loads(found)}

    def file(self, *, title: str, body: str, labels: Sequence[str]) -> int:
        argv = ["issue", "create", "--repo", self.repo, "--title", title, "--body", body]
        for label in labels:
            argv += ["--label", label]
        answered = self._gh(*argv)
        return _number_in(answered)

    def withdraw(self, number: int, reason: str) -> None:
        self._gh(
            "issue",
            "close",
            str(number),
            "--repo",
            self.repo,
            "--reason",
            "not planned",
            "--comment",
            reason,
        )


def _number_in(url: str) -> int:
    """The issue number out of what `gh issue create` prints, which is a URL."""
    tail = url.strip().rstrip("/").rsplit("/", 1)[-1]
    if not tail.isdigit():
        raise BoardError(f"filed, but the board answered with no issue number: {url!r}")
    return int(tail)


def _subprocess_runner(argv: Sequence[str]) -> tuple[int, str, str]:
    done = subprocess.run(argv, capture_output=True, text=True)
    return done.returncode, done.stdout, done.stderr
