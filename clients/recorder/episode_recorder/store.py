"""The git repository an episode is written into, and nothing above it.

Git is driven as a subprocess rather than through a library because the store
has to be readable by the tools everybody already has. An episode that can only
be read back by the program that wrote it is a database with a confusing file
format; the whole point of this shape is that ``git log`` on somebody else's
machine is a complete reader.

Two environment decisions are load-bearing:

*Identity is always passed explicitly.* A commit takes its author from
``user.email`` when nothing else says otherwise, which means a recorder running
on a developer's laptop would sign the desktop's work with the developer's name.
Every commit here carries the identity the service issued at the handshake.

*The ambient configuration is switched off.* ``GIT_CONFIG_GLOBAL`` and
``GIT_CONFIG_SYSTEM`` are pointed at nothing, so a ``commit.gpgsign``, a
``core.hooksPath`` or an ``init.defaultBranch`` in somebody's dotfiles cannot
change what an episode looks like. A recording that reads differently on two
machines is not a recording.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

#: Reserved by RFC 2606 precisely so it can never resolve. A client id is an
#: identity, not a mailbox, and writing it as one that could receive mail would
#: be an invitation to try.
IDENTITY_DOMAIN = "computer-controls.invalid"

#: What the author line says when a client sent no label. The identity is still
#: exact — it is in the address — so this reads as a missing claim rather than
#: an unknown actor.
UNLABELLED = "an unnamed client"


class StoreError(RuntimeError):
    """A git command refused, carrying what git said rather than a return code."""


@dataclass(frozen=True)
class Author:
    """Who a commit is by.

    The service issues ``client_id`` when it accepts a connection; ``label`` is
    whatever the client called itself. The service's own identity module is
    explicit that a client may lie about its name but cannot lie about which
    connection it is on, so the two are kept apart here in the same way: the
    claim goes in the display name where a reader will read it as a claim, and
    the fact goes in the address where git will key off it.
    """

    client_id: str
    label: str = ""

    @property
    def name(self) -> str:
        return self.label or UNLABELLED

    @property
    def email(self) -> str:
        return f"{self.client_id}@{IDENTITY_DOMAIN}"

    def env(self) -> dict[str, str]:
        return {
            "GIT_AUTHOR_NAME": self.name,
            "GIT_AUTHOR_EMAIL": self.email,
            "GIT_COMMITTER_NAME": self.name,
            "GIT_COMMITTER_EMAIL": self.email,
        }


class Store:
    """A git repository with a working tree, addressed by path."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        # A tilde is how a person writes a home directory, and taking it
        # literally would silently make a directory called "~" next to wherever
        # the process happened to be standing.
        self.path = Path(path).expanduser()

    # -- running git ----------------------------------------------------

    def git(self, *args: str, author: Author | None = None, check: bool = True) -> str:
        env = dict(os.environ)
        env.update(
            {
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_CONFIG_SYSTEM": os.devnull,
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_TERMINAL_PROMPT": "0",
                "GIT_OPTIONAL_LOCKS": "0",
            }
        )
        if author is not None:
            env.update(author.env())

        done = subprocess.run(
            ("git", "-C", str(self.path), *args),
            capture_output=True,
            text=True,
            env=env,
        )
        if check and done.returncode != 0:
            detail = (done.stderr or done.stdout).strip()
            raise StoreError(f"git {' '.join(args)} failed: {detail}")
        return done.stdout.strip()

    # -- lifecycle ------------------------------------------------------

    def init(self, author: Author) -> None:
        """Create the repository if it is not there, with an empty root commit.

        The root commit exists so that ``main`` is a real ref from the first
        moment. Without it the first episode would have nothing to branch from,
        and a store with no episodes yet would answer differently from a store
        with one — a difference every reader would have to know about.
        """
        self.path.mkdir(parents=True, exist_ok=True)
        if (self.path / ".git").exists():
            return
        self.git("init", "--quiet", "--initial-branch=main")
        self.git(
            "commit",
            "--quiet",
            "--allow-empty",
            "--message",
            "the store opens",
            author=author,
        )

    # -- writing --------------------------------------------------------

    def write(self, relative: str, content: str) -> None:
        target = self.path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def remove(self, relative: str) -> None:
        target = self.path / relative
        if target.exists():
            target.unlink()
            self._prune(target.parent)

    def _prune(self, directory: Path) -> None:
        """Drop directories emptied by a removal, up to the repository root.

        Git does not track directories, so an empty one left behind is invisible
        in a commit and present on disk — a difference between what the store
        says and what it holds.
        """
        root = self.path.resolve()
        current = directory.resolve()
        while current != root and current.is_dir() and not any(current.iterdir()):
            current.rmdir()
            current = current.parent

    def commit(self, message: str, author: Author) -> str:
        self.git("add", "--all")
        self.git("commit", "--quiet", "--message", message, author=author)
        return self.git("rev-parse", "HEAD")

    # -- branches and refs ----------------------------------------------

    def start_branch(self, name: str, *, at: str = "main") -> None:
        """Branch, and record where the branch began.

        The branch point is written down rather than worked out later. Once an
        episode is merged into `main` there is no longer any range expression
        that means "the commits this episode contributed" — `main..branch` goes
        empty at the moment the work becomes canon, which is the moment it
        becomes most worth reading. A ref costs nothing and cannot be inferred
        wrong.
        """
        self.git("checkout", "--quiet", "-b", name, at)
        self.git("update-ref", self._base_ref(name), self.git("rev-parse", at))

    def checkout(self, name: str) -> None:
        self.git("checkout", "--quiet", name)

    def branches(self) -> list[str]:
        listed = self.git("for-each-ref", "--format=%(refname:short)", "refs/heads")
        return [line for line in listed.splitlines() if line]

    def merged_branches(self) -> list[str]:
        listed = self.git(
            "for-each-ref", "--format=%(refname:short)", "--merged=main", "refs/heads"
        )
        return [line for line in listed.splitlines() if line]

    def _base_ref(self, name: str) -> str:
        return f"refs/episode-base/{name}"

    def base(self, name: str) -> str:
        """The commit an episode branched from."""
        return self.git("rev-parse", self._base_ref(name))

    def range(self, name: str) -> str:
        """The commits an episode contributed, merged or not."""
        return f"{self.base(name)}..{name}"

    def subjects(self, ref: str) -> list[str]:
        """Every commit subject an episode contributed, oldest first."""
        listed = self.git("log", "--reverse", "--format=%s", self.range(ref))
        return [line for line in listed.splitlines() if line]
