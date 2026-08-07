"""Fetch the skills other people published, into the folder the runtime reads.

The commons is already an extension root: `skills/` is scanned by the registry
here and mounted read-only by the hub. Fetching does not invent a second
mechanism for that — it puts a merged skill's two files into that folder, the
same two files a locally-derived skill leaves there, and the runtime never has
to know which is which.

Which is exactly why this module writes a third file. A fetched skill has to be
*identifiable* — fetching is opt-in and revocable, and "revocable" is a promise
about removal that cannot be kept if the only thing distinguishing a route this
machine derived from a route it downloaded is somebody's memory. `FETCHED.json`
is that difference, and `remove()` refuses to delete a folder that does not
carry one. Taking the commons back off a machine cannot cost it the work it did
itself.

The marker is written *before* the two documents rather than after. A fetch
interrupted halfway leaves a folder that is incomplete, and the question that
matters about an incomplete folder is not whether it is a valid skill — the
registry already skips those — but whether the person can get rid of it. Marker
first means yes.

Nothing arriving here is trusted because it arrived. The published set is a
public folder in a public repository and this machine reads it without a
credential, so what comes back is text from the internet: the name is held to
the same slug shape a skill is allowed to have before it is used as a path, the
header must parse as one this package would have written, the folder name and
the skill's own name must agree, the advisory sentence must be on it, and the
pair is scanned for the shapes that must never appear in a published skill. A
route that fails any of those is not a skill that needs fixing on the far end;
it is a file this machine declines to keep. And a route that passes all of them
is still advisory — it is what worked on another machine, against the version
named in its own frontmatter, and the agent following it verifies each step
against the tree in front of it.
"""

from __future__ import annotations

import json
import shutil
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Protocol

from . import frontmatter
from .frontmatter import MalformedHeader
from .outbound import over_http
from .registry import REVIEW_FILE, SKILL_FILE
from .render import ADVISORY
from .skill import SLUG
from .validator import scan

#: What marks a folder as something this machine downloaded rather than
#: derived. Named for what it answers rather than for what it is, and readable
#: by a person with `cat` — the file that says "you may delete this" should not
#: itself need a tool.
ORIGIN_FILE = "FETCHED.json"

#: Where in the published repository the commons lives, mirroring `SKILLS_DIR`
#: on the write side. The two are the same folder seen from the two ends.
SKILLS_PATH = "skills"

#: How long to wait on the published set before answering that it is not there.
TIMEOUT = 30.0


class NotFetchable(RuntimeError):
    """Something offered by the published set that this machine will not keep."""


@dataclass(frozen=True)
class Fetched:
    """One skill that came from the commons, and where it came from."""

    name: str
    source: str
    when: str
    path: Path


class Published(Protocol):
    """The published set, as a machine with no credential can see it."""

    def names(self) -> tuple[str, ...]:
        """Every skill the commons holds, by name."""

    def read(self, name: str) -> tuple[str, str]:
        """One skill's two documents: `SKILL.md`, then `REVIEW.md`."""

    @property
    def where(self) -> str:
        """What to record as the origin of anything read from here."""


class Fetcher:
    """The fetch verb: what is out there, take one, list mine, give it back."""

    def __init__(
        self,
        commons: str | Path,
        source: Published,
        *,
        today: Any = None,
    ) -> None:
        self.commons = Path(commons)
        self.source = source
        self._today = today or (lambda: date.today().isoformat())

    # -- looking --------------------------------------------------------

    def available(self) -> tuple[str, ...]:
        """What the published set holds that this machine does not."""
        return tuple(
            name
            for name in self.source.names()
            if SLUG.fullmatch(name) and not (self.commons / name).exists()
        )

    def fetched(self) -> tuple[Fetched, ...]:
        """What on this machine came from the commons, in name order.

        Read off the folders rather than kept in an index beside them. An index
        is a second record that can disagree with the directory, and the
        disagreement always resolves in favour of the thing a person can see.
        """
        if not self.commons.is_dir():
            return ()
        found = []
        for folder in sorted(self.commons.iterdir()):
            marker = folder / ORIGIN_FILE
            if not marker.is_file():
                continue
            try:
                held = json.loads(marker.read_text())
            except ValueError:
                held = {}
            found.append(
                Fetched(
                    name=folder.name,
                    source=str(held.get("source", "")),
                    when=str(held.get("fetched", "")),
                    path=folder,
                )
            )
        return tuple(found)

    # -- taking ---------------------------------------------------------

    def fetch(self, name: str) -> Fetched:
        """Take one skill from the published set, with its review beside it.

        One at a time, like publishing and for the same reason: a skill is read
        one at a time, and a call that took the whole commons would be a person
        agreeing to a folder rather than to a route.
        """
        if not SLUG.fullmatch(name):
            raise NotFetchable(
                f"{name!r} is not a name a published skill can have: a name"
                " that is not a slug is a name that can be a path"
            )

        folder = self.commons / name
        if folder.exists() and not (folder / ORIGIN_FILE).is_file():
            raise NotFetchable(
                f"{name!r} is already here and was not fetched: a fetch that"
                " overwrote a route this machine derived would be a download"
                " deleting somebody's work"
            )

        document, review = self.source.read(name)
        _refuse_unless_publishable(name, document, review)

        folder.mkdir(parents=True, exist_ok=True)
        origin = Fetched(
            name=name,
            source=self.source.where,
            when=self._today(),
            path=folder,
        )
        # The marker first. See the note at the top of this module: a fetch
        # that dies halfway has to leave something the person can remove.
        (folder / ORIGIN_FILE).write_text(
            json.dumps(
                {
                    "version": 1,
                    "skill": name,
                    "source": origin.source,
                    "fetched": origin.when,
                },
                sort_keys=True,
            )
            + "\n"
        )
        (folder / SKILL_FILE).write_text(document)
        (folder / REVIEW_FILE).write_text(review)
        return origin

    def remove(self, name: str) -> Fetched:
        """Give one fetched skill back, and refuse to touch anything else."""
        folder = self.commons / name
        marker = folder / ORIGIN_FILE
        if not marker.is_file():
            raise NotFetchable(
                f"{name!r} did not come from the commons: what this machine"
                " worked out is not the commons' to take away"
            )
        held = next(
            (entry for entry in self.fetched() if entry.name == name),
            Fetched(name=name, source="", when="", path=folder),
        )
        shutil.rmtree(folder)
        return held


def _refuse_unless_publishable(name: str, document: str, review: str) -> None:
    """Every question this machine can answer about text it did not write."""
    try:
        fields, _ = frontmatter.parse(document)
    except MalformedHeader as refused:
        raise NotFetchable(
            f"{name!r} does not carry a header this package would have"
            f" written: {refused}"
        ) from refused

    if str(fields.get("name", "")) != name:
        raise NotFetchable(
            f"{name!r} calls itself {fields.get('name')!r}: a skill found under"
            " one name and loaded under another is a skill an agent cannot be"
            " told it is using"
        )

    if ADVISORY not in document:
        raise NotFetchable(
            f"{name!r} does not carry the advisory sentence: a route that does"
            " not say it is advisory is a route somebody would follow without"
            " checking the tree in front of them"
        )

    if not review.strip():
        raise NotFetchable(
            f"{name!r} arrived without its review: a person who wants to know"
            " why the collective accepted this route should not have to leave"
            " the machine to find out"
        )

    found = scan(document + "\n" + review)
    if found:
        raise NotFetchable(
            f"{name!r} carries " + ", ".join(found) + ": the screens that ran"
            " where it was published run again where it lands, because a"
            " machine that trusted text for having been downloaded is a"
            " machine with a supply chain"
        )


@dataclass
class GitHubCommons:
    """The published set, read the way anybody without an account reads it.

    Two unauthenticated requests — the contents listing for the folder, and the
    raw files under it. No token is set on either, and the class has no field to
    put one in. A published commons that could only be read by somebody with an
    account would be a commons that is not published.
    """

    repo: str
    ref: str = "main"
    transport: Any = None
    timeout: float = TIMEOUT

    @property
    def where(self) -> str:
        return f"{self.repo}@{self.ref}"

    def names(self) -> tuple[str, ...]:
        listed = self._get(
            f"https://api.github.com/repos/{self.repo}/contents/"
            f"{SKILLS_PATH}?ref={urllib.parse.quote(self.ref)}"
        )
        try:
            entries = json.loads(listed)
        except ValueError as unreadable:
            raise NotFetchable(
                f"the published set at {self.where} did not answer with a"
                f" listing: {unreadable}"
            ) from unreadable
        if not isinstance(entries, list):
            raise NotFetchable(
                f"the published set at {self.where} did not answer with a listing"
            )
        return tuple(
            str(entry["name"])
            for entry in entries
            if isinstance(entry, dict) and entry.get("type") == "dir"
        )

    def read(self, name: str) -> tuple[str, str]:
        if not SLUG.fullmatch(name):
            raise NotFetchable(f"{name!r} is not a name a published skill can have")
        return (self._raw(name, SKILL_FILE), self._raw(name, REVIEW_FILE))

    def _raw(self, name: str, file: str) -> str:
        return self._get(
            f"https://raw.githubusercontent.com/{self.repo}/"
            f"{urllib.parse.quote(self.ref)}/{SKILLS_PATH}/{name}/{file}"
        )

    def _get(self, url: str) -> str:
        request = urllib.request.Request(
            url, method="GET", headers={"accept": "application/vnd.github+json"}
        )
        send = self.transport or over_http
        try:
            status, body = send(request, self.timeout)
        except OSError as unreachable:
            raise NotFetchable(
                f"the published set could not be reached: {unreachable}"
            ) from unreachable
        if status >= 400:
            raise NotFetchable(f"{url} answered {status}")
        return body
