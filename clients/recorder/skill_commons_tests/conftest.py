"""Fixtures for the skill commons suite.

The skill built here is the Discord route the whole feature came from — an
agent spent fifty nodes of an accessibility tree finding a private message, and
nowhere to put what it learned is the thing this package is. It is used as the
example everywhere rather than a `foo-bar` invention, because a fixture that is
not a real route proves the package can hold a shape somebody made up.
"""

from __future__ import annotations

import urllib.request
from pathlib import Path

import pytest

from episode_recorder import Author

from skill_commons import Receipt, Skill, Step, Verification, render, render_review
from skill_commons.registry import SkillRegistry, write_pair


def a_route(**changed) -> Skill:
    """The Discord route, verified three times against a named version."""
    fields = dict(
        app="discord",
        task="read-latest-direct-message",
        steps=(
            Step(ordinal=1, method="census"),
            Step(ordinal=2, method="setAttention", role="window"),
            Step(ordinal=3, method="describeElement", role="document text"),
            Step(ordinal=4, method="describeElement", role="list",
                 landmark="Private channels"),
            Step(ordinal=5, method="describeElement", role="list item"),
        ),
        verification=Verification(
            app_version="1.0.151", when="2026-08-05", successes=3
        ),
        author=Author(client_id="client-7", label="hub"),
    )
    fields.update(changed)
    return Skill(**fields)


def another_route(**changed) -> Skill:
    """A second route, in a second application, so that a list has an order."""
    fields = dict(
        app="firefox",
        task="open-a-new-tab",
        steps=(
            Step(ordinal=1, method="census"),
            Step(ordinal=2, method="invokeAction", role="push button",
                 landmark="New Tab"),
        ),
        verification=Verification(
            app_version="132.0", when="2026-07-30", successes=2
        ),
        author=Author(client_id="client-9", label="hub"),
    )
    fields.update(changed)
    return Skill(**fields)


@pytest.fixture
def route() -> Skill:
    return a_route()


@pytest.fixture
def commons(tmp_path: Path) -> Path:
    """A commons directory holding two admitted skills."""
    root = tmp_path / "skills"
    root.mkdir()
    write_pair(root, a_route())
    write_pair(root, another_route())
    return root


@pytest.fixture
def registry(commons: Path) -> SkillRegistry:
    return SkillRegistry(commons)


class FakeForge:
    """A forge that answers `gh` without one, and remembers what it was asked.

    The same trick the recorder's `FakeBoard` plays, for the same reason: what
    can be proved without a network is that the command says what we meant, and
    that is the half that goes wrong. Numbers ascend because a pull request
    number is the only clock in this design.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.next_number = 200
        self.open: dict[int, str] = {}
        self.closed: dict[int, str] = {}
        self.fail_with: str = ""

    def __call__(self, argv):
        argv = tuple(argv)
        self.calls.append(argv)
        if self.fail_with:
            return 1, "", self.fail_with
        if argv[1:3] == ("pr", "create"):
            number = self.next_number
            self.next_number += 1
            self.open[number] = _flag(argv, "--head")
            return 0, f"https://github.com/owner/repo/pull/{number}\n", ""
        if argv[1:3] == ("pr", "list"):
            listed = ", ".join(f'{{"number": {n}}}' for n in sorted(self.open))
            return 0, f"[{listed}]", ""
        if argv[1:3] == ("pr", "close"):
            number = int(argv[3])
            self.open.pop(number, None)
            self.closed[number] = _flag(argv, "--comment")
            return 0, "", ""
        return 0, "", ""

    def argv_for(self, *prefix: str) -> tuple[str, ...]:
        """The one call that started with these words, or a failed assertion."""
        matches = [call for call in self.calls if call[: len(prefix)] == prefix]
        assert matches, f"nothing was asked of the forge starting {prefix}"
        return matches[-1]


def _flag(argv: tuple[str, ...], flag: str) -> str:
    return argv[argv.index(flag) + 1] if flag in argv else ""


@pytest.fixture
def forge() -> FakeForge:
    return FakeForge()


class FakeService:
    """The publishing service (#160), before there is one.

    It records the pair it was handed rather than a summary of it, because the
    thing every publish test wants to ask is whether the bytes that arrived are
    the bytes the person read.
    """

    def __init__(self) -> None:
        self.proposals: list[dict[str, str]] = []
        self.next_number = 300
        self.refuse_with: str = ""

    def propose(self, *, skill: str, document: str, review: str) -> Receipt:
        self.proposals.append(
            {"skill": skill, "document": document, "review": review}
        )
        if self.refuse_with:
            return Receipt(skill=skill, accepted=False, reason=self.refuse_with)
        number = self.next_number
        self.next_number += 1
        return Receipt(
            skill=skill,
            accepted=True,
            where=f"https://github.com/owner/repo/pull/{number}",
        )

    @property
    def last(self) -> dict[str, str]:
        assert self.proposals, "nothing was offered to the service"
        return self.proposals[-1]


class FakePublished:
    """The published set, answered from memory instead of over the wire.

    Built from real skills so that what a fetch reads back is what a merge
    would actually have left in the repository — the same rendered pair, not a
    fixture shaped like one.
    """

    where = "owner/repo@main"

    def __init__(self, *skills: Skill) -> None:
        self.holds = {
            skill.name: (render(skill), render_review(skill)) for skill in skills
        }
        self.reads: list[str] = []

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self.holds))

    def read(self, name: str) -> tuple[str, str]:
        self.reads.append(name)
        return self.holds[name]


class FakeTransport:
    """Scripted answers, and every request that was made to get them.

    `answers` is keyed by whatever part of the URL is worth naming, so a test
    can say what the listing says and what each file says without writing the
    whole address twice.
    """

    def __init__(
        self, status: int = 200, body: str = "{}", answers: dict | None = None
    ) -> None:
        self.status = status
        self.body = body
        self.answers = answers or {}
        self.requests: list[urllib.request.Request] = []
        self.raise_with: OSError | None = None

    def __call__(self, request, timeout):
        self.requests.append(request)
        if self.raise_with:
            raise self.raise_with
        for fragment, answered in self.answers.items():
            if fragment in request.full_url:
                return answered if isinstance(answered, tuple) else (200, answered)
        return self.status, self.body

    def asked_for(self, fragment: str) -> urllib.request.Request:
        matched = [one for one in self.requests if fragment in one.full_url]
        assert matched, f"nothing was asked for containing {fragment!r}"
        return matched[-1]

    @property
    def last(self) -> urllib.request.Request:
        assert self.requests, "no request was made"
        return self.requests[-1]


@pytest.fixture
def service() -> FakeService:
    return FakeService()


@pytest.fixture
def published() -> FakePublished:
    return FakePublished(a_route(), another_route())


@pytest.fixture
def here(tmp_path: Path) -> Path:
    """An empty commons on the machine doing the fetching."""
    root = tmp_path / "fetched"
    root.mkdir()
    return root
