"""Fixtures for the recorder suite.

The action results here are built by asking the service's own diff engine what
changed between two snapshots, rather than by writing changes out by hand. A
hand-written fixture would prove that the recorder can record a shape somebody
invented; this proves it can record the shape the desktop service actually
sends, and it fails on the day that shape moves.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from desktop_service import state

from episode_recorder import Agent, Filer, Recorder

SCHEMA = json.loads(
    (Path(__file__).resolve().parents[3] / "protocol" / "schema.json").read_text()
)
CHANGE = SCHEMA["$defs"]["change"]


def conformant(**fields: Any) -> dict[str, Any]:
    """A change built by hand, refused unless the protocol would allow it.

    Some change kinds are in the vocabulary but are not produced by any snapshot
    diff yet. Recording those needs a hand-built change, and a hand-built change
    is exactly where a fixture drifts into a shape the service would never send
    — so this asks the frozen schema first.
    """
    unknown = set(fields) - set(CHANGE["properties"])
    assert not unknown, f"not fields of a change: {sorted(unknown)}"
    missing = set(CHANGE["required"]) - set(fields)
    assert not missing, f"a change must carry: {sorted(missing)}"
    assert fields["kind"] in CHANGE["properties"]["kind"]["enum"]
    return dict(fields)


def effects_of(*changes: dict[str, Any], action_id: str = "act-hand") -> dict[str, Any]:
    """An action result whose effects are the given changes."""
    revisions = [change["revision"] for change in changes]
    return {
        "actionId": action_id,
        "ok": True,
        "backend": "accessibility",
        "fallbacksUsed": [],
        "durationMs": 3,
        "observedEffects": {
            "fromRevision": min(revisions) - 1,
            "toRevision": max(revisions),
            "changes": list(changes),
        },
    }


def window(window_id: str, title: str = "a window", active: bool = False) -> state.WindowFacts:
    return state.WindowFacts(
        window_id=window_id,
        application_id="app-1",
        application_name="Test App",
        title=title,
        role="frame",
        active=active,
    )


def snapshot(revision: int, *windows: state.WindowFacts, **kwargs: Any) -> state.Snapshot:
    return state.Snapshot(
        revision=revision, windows={w.window_id: w for w in windows}, **kwargs
    )


def action(
    before: state.Snapshot,
    after: state.Snapshot,
    *,
    action_id: str = "act-1",
    ok: bool = True,
    backend: str = "accessibility",
    fallbacks: tuple[str, ...] = (),
    partial: bool = False,
) -> dict[str, Any]:
    """An action result carrying the service's real diff as its effects."""
    result: dict[str, Any] = {
        "actionId": action_id,
        "ok": ok,
        "backend": backend,
        "fallbacksUsed": list(fallbacks),
        "durationMs": 12,
        "observedEffects": {
            "fromRevision": before.revision,
            "toRevision": after.revision,
            "changes": state.diff(before, after),
            "partial": partial,
            "settledMs": 250,
        },
    }
    if not ok:
        result["error"] = {"code": "ACTION_NOT_SUPPORTED", "message": "no tier could"}
    return result


@pytest.fixture
def agent() -> Agent:
    return Agent(
        client_id="cl-1a2b3c4d",
        label="lister",
        instructions="Sell things. Do not haggle below the floor price.",
        prompt="Sell the PS5 for at least 500.",
        tools=("desktop_invoke_element", "desktop_type_text"),
        model="claude-opus-5",
    )


@pytest.fixture
def reviewer() -> Agent:
    return Agent(client_id="cl-99887766", label="auditor", model="claude-opus-5")


@pytest.fixture
def recorder(tmp_path) -> Recorder:
    return Recorder(tmp_path / "episodes")


class FakeBoard:
    """A board that keeps what it was handed, so a decision can be read back.

    Standing in for GitHub rather than for the filer's own bookkeeping: it
    answers the three questions a board answers and remembers nothing the filer
    would need to be told twice. The numbers ascend the way a real board's do,
    because the filer breaks a tie by asking which issue is older and issue
    numbers are the only clock in this design.
    """

    def __init__(self) -> None:
        self.issues: dict[int, dict[str, Any]] = {}
        self.unaccounted: set[int] = set()
        self._next = 1

    def open_issues(self) -> set[int]:
        opened = {n for n, issue in self.issues.items() if issue["state"] == "open"}
        return opened | self.unaccounted

    def file(self, *, title: str, body: str, labels: Any) -> int:
        number = self._next
        self._next += 1
        self.issues[number] = {
            "title": title,
            "body": body,
            "labels": tuple(labels),
            "state": "open",
            "closed_with": "",
        }
        return number

    def withdraw(self, number: int, reason: str) -> None:
        self.issues[number]["state"] = "closed"
        self.issues[number]["closed_with"] = reason

    def only(self) -> dict[str, Any]:
        assert len(self.issues) == 1, f"expected one issue, got {len(self.issues)}"
        return next(iter(self.issues.values()))


@pytest.fixture
def board() -> FakeBoard:
    return FakeBoard()


@pytest.fixture
def filer(recorder, board, reviewer):
    """A filer on this store, switched on unless a test says otherwise."""

    def make(*, cap: int = 5, enabled: bool | None = True, environ=None) -> Filer:
        return Filer(
            recorder.store.path,
            board,
            reviewer.author,
            cap=cap,
            enabled=enabled,
            environ=environ,
        )

    return make
