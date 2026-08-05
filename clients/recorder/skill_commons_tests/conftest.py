"""Fixtures for the skill commons suite.

The skill built here is the Discord route the whole feature came from — an
agent spent fifty nodes of an accessibility tree finding a private message, and
nowhere to put what it learned is the thing this package is. It is used as the
example everywhere rather than a `foo-bar` invention, because a fixture that is
not a real route proves the package can hold a shape somebody made up.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from episode_recorder import Author

from skill_commons import Skill, Step, Verification
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
