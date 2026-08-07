"""Read the candidate rows, ask ``gates`` about each one, write back the ones
it approves.

Everything interesting is in ``gates``. What is left here is I/O, and it is kept
deliberately dull: one query to gather candidates, one decision per row, one
UPDATE for the survivors. The original keeper did its thinking inside a single
SQL statement, where it could not be tested and where adding a condition meant
editing a `WITH` clause in a heredoc in a shell script. That is why it never
grew the conditions it needed.

Run it the way cron does::

    python3 -m factory_keeper.keeper

Add ``--dry-run`` to print the decisions without writing anything, which is the
first thing to reach for when the fleet goes quiet and the keeper is the
suspect.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from factory_keeper.gates import (  # noqa: E402
    Binding,
    Decision,
    PendingStart,
    WorkItem,
    should_requeue,
)

#: The container and credentials the original keeper used, kept identical so
#: that swapping the cron entry changes behaviour and nothing else.
CONTAINER = os.environ.get("FACTORY_DB_CONTAINER", "mastracode-web-db")
DB_USER = os.environ.get("FACTORY_DB_USER", "user")
DB_NAME = os.environ.get("FACTORY_DB_NAME", "mastracode_web")

LOG_PATH = Path(os.environ.get("FACTORY_KEEPER_LOG", Path.home() / "factory-keeper.log"))

#: Inherited from the original: if this many runs are genuinely in flight, the
#: fleet is busy and nothing needs waking. Unlike the gates, this is a capacity
#: question rather than a correctness one.
MAX_LEASED = 3
MAX_RETRY = 5

#: psql's unit separator. Chosen over a comma because kickoff messages are full
#: of both commas and newlines.
FIELD_SEP = "\x1f"
ROW_SEP = "\x1e"

CANDIDATE_QUERY = f"""
WITH newest AS (
  SELECT DISTINCT ON (binding_id) id
  FROM factory_pending_starts
  WHERE status = 'sent'
  ORDER BY binding_id, created_at DESC
)
SELECT
  ps.id, ps.binding_id, ps.status, ps.attempts, ps.created_at,
  b.role, b.status, b.thread_id,
  w.id, w.stages::text,
  w.metadata->>'githubIssueNumber',
  (SELECT max(m."createdAtZ") FROM mastra_messages m WHERE m.thread_id = b.thread_id),
  ps.message
FROM factory_pending_starts ps
JOIN newest ON newest.id = ps.id
LEFT JOIN factory_run_bindings b ON b.id::text = ps.binding_id
LEFT JOIN work_items w ON w.id::text = b.work_item_id
"""

#: Appended when a run is confined to one tenant. Both tools default to the
#: whole table because that is what the cron wants, which makes `all rows` the
#: easy path and every test a potential fleet-wide write. Tests pass an org so
#: they can only reach rows they created.
ORG_FILTER = "WHERE ps.org_id = {org}"


@dataclass(frozen=True)
class Candidate:
    """One row, plus everything the gates need to judge it."""

    row: PendingStart
    binding: Binding
    item: WorkItem | None
    issue_number: str | None
    thread_last_activity: datetime | None


def psql(sql: str, *, expect_rows: bool) -> str:
    """Run one statement inside the database container."""
    command = ["docker", "exec", CONTAINER, "psql", "-U", DB_USER, "-d", DB_NAME]
    command += ["-tA", "-F", FIELD_SEP, "-R", ROW_SEP, "-c", sql] if expect_rows else ["-c", sql]

    finished = subprocess.run(command, capture_output=True, text=True)
    if finished.returncode != 0:
        raise RuntimeError(f"psql failed: {finished.stderr.strip()}")
    return finished.stdout


def parse_timestamp(raw: str) -> datetime | None:
    """Parse a psql timestamp into an aware UTC datetime.

    The table mixes both kinds — `factory_pending_starts.created_at` carries a
    zone, `mastra_messages."createdAt"` does not — and subtracting one from the
    other raises. Rather than leave that landmine for the gates, everything is
    made aware here, at the one place values enter the process. A naive reading
    is assumed to be UTC, which is what the database stores.
    """
    if not raw:
        return None

    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def sql_quote(value: str) -> str:
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def load_candidates(org_id: str | None = None) -> list[Candidate]:
    query = CANDIDATE_QUERY
    if org_id:
        query += "\n" + ORG_FILTER.format(org=sql_quote(org_id))

    output = psql(query, expect_rows=True)
    candidates: list[Candidate] = []

    for raw_row in output.split(ROW_SEP):
        if not raw_row.strip():
            continue
        fields = raw_row.split(FIELD_SEP)
        if len(fields) < 13:
            continue

        (
            row_id, binding_id, status, attempts, created_at,
            role, binding_status, thread_id,
            item_id, stages, issue_number, last_activity, message,
        ) = fields[:13]

        candidates.append(
            Candidate(
                row=PendingStart(
                    id=row_id,
                    binding_id=binding_id,
                    status=status,
                    attempts=int(attempts or 0),
                    created_at=parse_timestamp(created_at) or datetime.now(timezone.utc),
                    message=message or None,
                ),
                # A row whose binding vanished is described honestly rather than
                # skipped: the gates have a verdict for it and the log should
                # carry that verdict like any other.
                binding=Binding(
                    id=binding_id,
                    role=role or "unknown",
                    status=binding_status or "missing",
                    thread_id=thread_id or None,
                ),
                item=WorkItem.from_json(item_id, stages) if item_id else None,
                issue_number=issue_number or None,
                thread_last_activity=parse_timestamp(last_activity),
            )
        )

    return candidates


def issue_state(issue_number: str | None) -> str | None:
    """Ask GitHub whether the linked issue is closed. None when it cannot say.

    Failure is deliberately indistinguishable from `don't know`, and the gate
    treats `don't know` as no reason to refuse. A keeper that halted the fleet
    because `gh` was not on cron's PATH would be a worse bug than the one this
    is fixing.

    Only `state` is requested. The issue-fetch layer rejects `stateReason` as an
    unknown field, which is worth knowing before reaching for a richer verdict.
    """
    if not issue_number:
        return None

    try:
        finished = subprocess.run(
            ["gh", "issue", "view", issue_number, "--json", "state", "--jq", ".state"],
            capture_output=True,
            text=True,
            timeout=20,
            env={**os.environ, "NO_COLOR": "1"},
        )
    except (OSError, subprocess.SubprocessError):
        return None

    return finished.stdout.strip() or None if finished.returncode == 0 else None


def requeue(row_ids: list[str]) -> None:
    quoted = ", ".join(f"'{row_id}'" for row_id in row_ids)
    psql(
        "UPDATE factory_pending_starts SET status='retry', attempts=0, "
        "available_at=now(), lease_owner=NULL, lease_expires_at=NULL, "
        f"last_error=NULL, updated_at=now() WHERE id IN ({quoted});",
        expect_rows=False,
    )


def count(status: str) -> int:
    raw = psql(
        f"SELECT count(*) FROM factory_pending_starts WHERE status='{status}';",
        expect_rows=True,
    )
    # `-R` applies to counts as well as result sets, so the separator has to
    # come off before int() sees it.
    return int(raw.replace(ROW_SEP, "").strip() or 0)


def log(line: str) -> None:
    stamp = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    with LOG_PATH.open("a") as handle:
        handle.write(f"{stamp} {line}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print every decision without writing to the database.",
    )
    parser.add_argument(
        "--org-id",
        default=None,
        help="Confine the run to one tenant's rows. Used by the tests.",
    )
    arguments = parser.parse_args(argv)

    leased, retrying = count("leased"), count("retry")
    fleet_is_busy = leased >= MAX_LEASED or retrying >= MAX_RETRY
    if fleet_is_busy:
        log(f"skip (leased={leased} retry={retrying}) fleet busy")
        # A dry run reports through the capacity guard rather than stopping at
        # it. The guard is about capacity, not correctness, and the moment
        # somebody reaches for --dry-run is usually the moment the fleet looks
        # stuck - which is exactly when the decisions are worth seeing and
        # exactly when this counter is high. It writes nothing either way.
        if not arguments.dry_run:
            return 0

    now = datetime.now(timezone.utc)
    approved: list[str] = []
    refusals: list[tuple[str, Decision]] = []

    for candidate in load_candidates(arguments.org_id):
        def judge(state: str | None) -> Decision:
            return should_requeue(
                row=candidate.row,
                binding=candidate.binding,
                item=candidate.item,
                issue_state=state,
                thread_last_activity=candidate.thread_last_activity,
                now=now,
            )

        # Asked in two passes so a tick spends no network calls on rows that
        # were going to be refused anyway. The gates are pure, so judging twice
        # costs nothing and the second verdict is the one that counts. Only a
        # row that survives every local gate is worth a GitHub round trip, and
        # on a quiet fleet that is usually none of them.
        decision = judge(None)
        if decision.requeue and candidate.issue_number:
            decision = judge(issue_state(candidate.issue_number))

        if decision.requeue:
            approved.append(candidate.row.id)
        else:
            refusals.append((candidate.row.id, decision))

    for row_id, decision in refusals:
        log(decision.log_line(row_id))

    if approved and not arguments.dry_run:
        requeue(approved)

    verb = "would requeue" if arguments.dry_run else "requeued"
    log(
        f"{verb} {len(approved)} (leased={leased} retry={retrying} "
        f"refused={len(refusals)})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
