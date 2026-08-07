"""Fixtures for the publishing service.

The route is the Discord one the whole feature came from, built the same way the
skill commons suite builds it, because a fixture that is not a real route proves
the service can publish a shape somebody made up.

The forge here is a fake, and the thing it fakes is the account. A real one would
need a token, a checkout and a network, and the property worth proving without any
of those is that a submission that should not publish never reaches the command
that would publish it — which is visible in what the forge was asked, and only
there.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from episode_recorder import Author

from skill_commons import (
    Skill,
    Step,
    Verification,
    as_document,
    render,
    render_review,
)
from skill_commons.forge import ForgeError

from commons_service import Publisher
from commons_service.publishing import TOKEN_ENV


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


def a_submission(skill: Skill | None = None, **changed) -> dict:
    """A submission as a well-behaved client sends it: the fields, and the pair."""
    skill = skill or a_route()
    payload = {
        "skill": as_document(skill),
        "document": render(skill),
        "review": render_review(skill),
    }
    payload.update(changed)
    return payload


def on_the_wire(payload: dict) -> bytes:
    return json.dumps(payload).encode()


class FakeForge:
    """A forge that answers without one, and remembers what it was asked.

    Numbers ascend because a pull request number is the only clock in this
    design. `proposals` is what the tests read: a submission that was refused
    leaves it empty, and that is the assertion worth making about a refusal.
    """

    def __init__(self, submitter: str = "client-7") -> None:
        self.submitter = submitter
        self.proposals: list[tuple[str, str, str]] = []
        self.open: set[int] = set()
        self.next_number = 200
        self.fail_with = ""

    def open_requests(self) -> set[int]:
        if self.fail_with:
            raise ForgeError(self.fail_with)
        return set(self.open)

    def propose(self, skill: Skill, *, base: str = "main", credit: str = "") -> int:
        if self.fail_with:
            raise ForgeError(self.fail_with)
        number = self.next_number
        self.next_number += 1
        self.open.add(number)
        self.proposals.append((skill.name, base, credit))
        return number

    def withdraw(self, number: int, reason: str) -> None:
        self.open.discard(number)


class Forges:
    """One forge per installation, all posting as the one account.

    The service holds a single credential; what varies per submission is which
    installation's open proposals are being counted, so this hands out a forge
    keyed by that and remembers each one for the tests to read.
    """

    def __init__(self) -> None:
        self.by_installation: dict[str, FakeForge] = {}

    def __call__(self, submitter: str) -> FakeForge:
        return self.by_installation.setdefault(submitter, FakeForge(submitter))

    @property
    def proposals(self) -> list[tuple[str, str, str]]:
        return [
            proposal
            for forge in self.by_installation.values()
            for proposal in forge.proposals
        ]


@pytest.fixture
def forges() -> Forges:
    return Forges()


@pytest.fixture
def credentialled() -> dict[str, str]:
    """An environment in which this service can post.

    A value that is not a credential and could not be mistaken for one. The
    service reads this variable as set-or-not and never for its contents.
    """
    return {TOKEN_ENV: "a-token-lives-here"}


@pytest.fixture
def ledger_path(tmp_path: Path) -> Path:
    return tmp_path / "submissions.jsonl"


@pytest.fixture
def publisher(forges: Forges, credentialled: dict[str, str]) -> Publisher:
    return Publisher(forges, environ=credentialled)
