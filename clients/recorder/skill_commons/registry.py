"""The commons, read: a directory of skills, listed, fetched and searched.

Not to be confused with `desktop_service.registry`, which is the element
reference registry and answers an entirely different question — whether the id a
caller is holding still names the element it was shown. The name collides
because both are registries in the ordinary sense and neither has a better word.
This one indexes procedures; that one guarantees identities.

There is no database. The registry is a directory, one folder per skill, and the
folder is the index — which is the same ruling the episode store makes about git
and for the same reasons. A directory is readable by anybody with the checkout
and by every tool that already exists, it needs nothing installed, and the
history of what was admitted and when is the repository's history rather than a
second record that can disagree with it.

Reading is deliberately forgiving in one direction and unforgiving in the other.
A folder that is not a skill — no `SKILL.md`, or a header this package would not
have written — is skipped rather than raised on, because a registry that refused
to list anything at all because one contributor's directory was malformed would
be a registry one bad merge takes offline. But a skill that *is* read is read
strictly: its header must parse, and what it claims about itself must be the
shape this package publishes. The skipped ones are not silent — `unreadable`
answers for them by name, so "the registry lists forty" and "the directory holds
forty-one" is a discrepancy somebody can see rather than one nobody can.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from . import frontmatter
from .frontmatter import MalformedHeader

#: The file the Agent Skills specification names, and the only one this registry
#: looks for. A folder without one is not a skill that failed to load; it is not
#: a skill.
SKILL_FILE = "SKILL.md"

#: The other half of a submission. Present in the repository so that what a
#: reviewer read is beside what they admitted, rather than only in a merged
#: pull request somebody would have to go and find.
REVIEW_FILE = "REVIEW.md"

#: Words too common to tell two skills apart. Kept short on purpose: a stop list
#: that grows becomes a list of terms nobody can search for.
NOISE = frozenset({"a", "an", "and", "the", "in", "of", "to", "for", "it", "is"})

WORDS = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True)
class Entry:
    """One admitted skill, as the registry holds it.

    The instructions are kept beside the metadata rather than behind a second
    read, because every caller that has a reason to fetch a skill has a reason
    to read it — and a lazy field is a second chance for the file on disk to
    have changed underneath the answer.
    """

    name: str
    description: str
    app: str
    task: str
    app_version_verified: str
    last_verified: str
    verified_count: int
    instructions: str
    path: Path

    @property
    def haystack(self) -> str:
        return " ".join(
            (self.name, self.description, self.app, self.task, self.instructions)
        ).lower()


@dataclass(frozen=True)
class Hit:
    """A skill a search matched, and how well."""

    entry: Entry
    score: int


@dataclass(frozen=True)
class Unreadable:
    """A folder that looked like a skill and could not be read as one."""

    path: Path
    reason: str


class SkillRegistry:
    """Every skill in a directory, read once, answered from memory.

    `refresh()` is explicit rather than automatic. A registry that re-read the
    disk on every question would give two different answers to the same question
    asked twice in one turn, which is exactly the property an agent reasoning
    about what it has available cannot have.
    """

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self._entries: dict[str, Entry] = {}
        self._unreadable: list[Unreadable] = []
        self.refresh()

    # -- reading --------------------------------------------------------

    def refresh(self) -> None:
        self._entries = {}
        self._unreadable = []
        if not self.root.is_dir():
            return
        for folder in sorted(self.root.iterdir()):
            if not folder.is_dir():
                continue
            document = folder / SKILL_FILE
            if not document.is_file():
                continue
            try:
                entry = _read(document)
            except (MalformedHeader, KeyError, ValueError) as refused:
                self._unreadable.append(Unreadable(path=folder, reason=str(refused)))
                continue
            if entry.name != folder.name:
                self._unreadable.append(
                    Unreadable(
                        path=folder,
                        reason=(
                            f"the folder is called {folder.name!r} and the skill"
                            f" calls itself {entry.name!r}: a skill found under"
                            " one name and loaded under another is a skill an"
                            " agent cannot be told it is using"
                        ),
                    )
                )
                continue
            self._entries[entry.name] = entry

    # -- asking ---------------------------------------------------------

    def list(self) -> tuple[Entry, ...]:
        """Every admitted skill, in the order the directory holds them."""
        return tuple(self._entries[name] for name in sorted(self._entries))

    def get(self, name: str) -> Entry | None:
        return self._entries.get(name)

    def has(self, name: str) -> bool:
        return name in self._entries

    def unreadable(self) -> tuple[Unreadable, ...]:
        """The folders that were skipped, and why.

        Answered rather than logged. A skipped skill is the difference between
        what a contributor thinks they published and what an agent can find, and
        that difference should be askable rather than in a file somebody has to
        know to look at.
        """
        return tuple(self._unreadable)

    def for_app(self, app: str) -> tuple[Entry, ...]:
        return tuple(entry for entry in self.list() if entry.app == app)

    def search(self, query: str, *, limit: int = 10) -> tuple[Hit, ...]:
        """The skills that match a query, best first.

        Word overlap, and deliberately nothing cleverer. An agent asking this
        already knows the application and roughly the task; the job is to find
        `discord-read-latest-direct-message` from "read a discord message",
        which is a matching problem a ranked substring count solves. Anything
        better belongs to the runtime's own search over the merged files, which
        has an index and a scoring function and is where a skill is looked up at
        the moment it is needed. This is the write side's own view.
        """
        terms = [word for word in WORDS.findall(query.lower()) if word not in NOISE]
        if not terms:
            return ()
        hits = []
        for entry in self.list():
            haystack = entry.haystack
            score = sum(
                _weight(entry, term) for term in terms if term in haystack
            )
            if score:
                hits.append(Hit(entry=entry, score=score))
        hits.sort(key=lambda hit: (-hit.score, hit.entry.name))
        return tuple(hits[:limit])


def write_pair(root: str | Path, skill) -> tuple[Path, Path]:
    """Put both halves of a submission on disk, and answer with where.

    Both files or neither. A commit carrying a skill without the review that
    justified it is a submission whose reviewer has nothing to read, and the
    cheapest place to make that impossible is the function that writes them.
    """
    from .render import render, render_review

    folder = Path(root) / skill.name
    folder.mkdir(parents=True, exist_ok=True)
    document = folder / SKILL_FILE
    review = folder / REVIEW_FILE
    document.write_text(render(skill))
    review.write_text(render_review(skill))
    return document, review


def _weight(entry: Entry, term: str) -> int:
    """How much a term matching is worth, by where it matched.

    A term in the name is what the skill is; a term in the body is something the
    skill mentions. Scoring them the same would rank a skill that walks past a
    message box above the one that reads it.
    """
    score = 1
    if term in entry.description.lower():
        score += 2
    if term in entry.name:
        score += 4
    return score


def _read(document: Path) -> Entry:
    fields, instructions = frontmatter.parse(document.read_text())
    metadata = fields.get("metadata")
    if not isinstance(metadata, dict):
        raise ValueError("a published skill carries a metadata block")
    return Entry(
        name=str(fields["name"]),
        description=str(fields["description"]),
        app=str(metadata["app"]),
        task=str(metadata["task"]),
        app_version_verified=str(metadata["app-version-verified"]),
        last_verified=str(metadata["last-verified"]),
        verified_count=int(metadata["verified-count"]),
        instructions=instructions,
        path=document.parent,
    )
