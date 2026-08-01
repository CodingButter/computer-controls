"""Doing things, and reporting honestly about what doing them caused.

Every action here answers three questions the caller would otherwise have to ask by
re-inspecting: did it work, which tier did it, and what changed as a result. The third is
the expensive one and the reason this layer exists. An acting API that returns `{"ok":
true}` forces the model to re-read the desktop after every click just to find out whether
a dialog appeared — which is most of the token cost of driving a computer.

Every action also leaves a record behind: an id, and the span of revisions it occupied.
The delta engine in the next phase reads those spans to decide whether a change is news
or merely the consequence of something the agent itself just did. Attribution is built
here, at the moment the knowledge exists, rather than reconstructed later from timestamps.
"""

from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from . import errors, settle, state

_action_ids = itertools.count(1)


@dataclass
class ActionRecord:
    """One action, and the window of revisions in which its effects landed.

    `first_revision` is stamped before the action is dispatched, not after. A toolkit
    that reacts synchronously would otherwise produce effects at a revision the record
    does not cover, and those effects would be reported to the agent as somebody else's
    news.
    """

    action_id: str
    method: str
    target_id: str
    first_revision: int
    last_revision: int
    partial: bool
    changes: list[dict[str, Any]] = field(default_factory=list)

    def covers(self, revision: int) -> bool:
        return self.first_revision <= revision <= self.last_revision


class ActionLog:
    """The recent history of what this session did.

    Bounded, because it is consulted per delta rather than audited: the audit trail in
    segment 3 is a different artifact with different retention. Keeping every action of a
    long-lived session here would grow without limit for no reader.
    """

    def __init__(self, limit: int = 256) -> None:
        self._records: list[ActionRecord] = []
        self._limit = limit

    def record(self, record: ActionRecord) -> None:
        self._records.append(record)
        if len(self._records) > self._limit:
            del self._records[: len(self._records) - self._limit]

    def covering(self, revision: int) -> list[ActionRecord]:
        return [record for record in self._records if record.covers(revision)]

    def latest(self) -> ActionRecord | None:
        return self._records[-1] if self._records else None


@dataclass
class Attempt:
    """One tier's attempt at an action. Tried in order; the first success wins."""

    backend: str
    run: Callable[[], bool]


def perform(
    method: str,
    target_id: str,
    attempts: list[Attempt],
    take_snapshot: Callable[[], state.Snapshot],
    log: ActionLog,
    quiet_ms: int = settle.DEFAULT_QUIET_MS,
    ceiling_ms: int = settle.DEFAULT_CEILING_MS,
) -> dict[str, Any]:
    """Run an action through the highest tier that works, then report its effects.

    Tiers are tried in the order given and the ones that failed are named in
    `fallbacksUsed`. A fallback that succeeds is still a fallback: a caller reading a
    result where X11 answered because the accessibility tier declined is being told
    something real about the application it is driving, and hiding it behind a plain
    success would make a degraded path look blessed.
    """
    action_id = f"act-{next(_action_ids):06d}"
    started = time.monotonic()
    before = take_snapshot()

    fallbacks: list[str] = []
    succeeded: str | None = None
    for attempt in attempts:
        if attempt.run():
            succeeded = attempt.backend
            break
        fallbacks.append(attempt.backend)

    settlement = settle.wait_for_quiet(
        take_snapshot, before, quiet_ms=quiet_ms, ceiling_ms=ceiling_ms
    )

    log.record(
        ActionRecord(
            action_id=action_id,
            method=method,
            target_id=target_id,
            first_revision=before.revision,
            last_revision=settlement.after.revision,
            partial=settlement.partial,
            changes=settlement.changes,
        )
    )

    result: dict[str, Any] = {
        "actionId": action_id,
        "ok": succeeded is not None,
        # An action nobody could perform still has to name a backend; the last tier
        # tried is the one that had the final say.
        "backend": succeeded or (attempts[-1].backend if attempts else "none"),
        "fallbacksUsed": fallbacks,
        "durationMs": int((time.monotonic() - started) * 1000),
        "observedEffects": {
            "fromRevision": before.revision,
            "toRevision": settlement.after.revision,
            "changes": settlement.changes,
            "partial": settlement.partial,
            "settledMs": settlement.settled_ms,
        },
    }
    if succeeded is None:
        result["error"] = {
            "code": errors.ErrorCode.ACTION_NOT_SUPPORTED,
            "message": (
                f"{method} was refused by every available tier "
                f"({', '.join(attempt.backend for attempt in attempts) or 'none'})"
            ),
        }
    return result


def perform_batch(
    run_one: Callable[[dict[str, Any]], dict[str, Any]],
    requested: list[dict[str, Any]],
    stop_on_failure: bool = True,
) -> dict[str, Any]:
    """Run a sequence of actions in one round trip.

    The point is not speed inside the service — it is that a caller driving a dialog does
    not spend a model turn per field. Four fields and a confirm button is one call.

    `stopOnFailure` defaults to stopping, because a batch is usually a sequence where each
    step assumes the last one worked. Typing into a field that never opened, then clicking
    a button that is not there, produces three failures that all describe the first one.

    Actions that never ran are reported by count rather than by placeholder: `completed`
    is how many were attempted, and a caller comparing it against what it sent knows
    exactly where the sequence stopped. A caller must be able to tell "failed" from "never
    happened", and this distinction does it without inventing results for actions that
    were never performed.
    """
    results: list[dict[str, Any]] = []

    for request in requested:
        outcome = run_one(request)
        results.append(outcome)
        if not outcome.get("ok") and stop_on_failure:
            break

    return {"results": results, "completed": len(results)}
