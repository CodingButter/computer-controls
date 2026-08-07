"""Retire the rows the gates will refuse for as long as they exist.

Gating stops the bleeding but leaves the wound: the table still holds rows that
every future tick will examine and refuse, forever, because nothing ever moves
a `sent` row out of `sent`. They are cheap to skip and free to ignore, but they
make the log noisy and they make `select status, count(*)` a lie about how much
work is outstanding.

This marks them `failed` with a `last_error` that says which gate refused them
and why. `failed` rather than deleted, deliberately: these rows are the evidence
for issue #210 and for whatever the upstream fix turns out to be, and a table
that has been tidied is a table that can no longer answer questions. Purging
them is an operator's decision to make later, with the forensics already read.

Only *permanent* refusals are retired. A row skipped because its thread is busy
is doing exactly what it should and will be woken on a later tick.

    python3 -m factory_keeper.reconcile              # dry run, prints a table
    python3 -m factory_keeper.reconcile --apply      # writes
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from factory_keeper.gates import should_requeue  # noqa: E402
from factory_keeper.keeper import (  # noqa: E402
    issue_state,
    load_candidates,
    psql,
    sql_quote,
)


def retire(row_id: str, reason: str) -> None:
    psql(
        "UPDATE factory_pending_starts SET status='failed', "
        f"last_error={sql_quote(reason)}, updated_at=now() "
        f"WHERE id={sql_quote(row_id)} AND status='sent';",
        expect_rows=False,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write the changes. Without this the run only reports.",
    )
    parser.add_argument(
        "--org-id",
        default=None,
        help=(
            "Confine the run to one tenant's rows. Without it, --apply writes "
            "across the whole table."
        ),
    )
    arguments = parser.parse_args(argv)

    now = datetime.now(timezone.utc)
    doomed: list[tuple[str, str]] = []
    surviving = 0

    for candidate in load_candidates(arguments.org_id):
        decision = should_requeue(
            row=candidate.row,
            binding=candidate.binding,
            item=candidate.item,
            issue_state=issue_state(candidate.issue_number),
            thread_last_activity=candidate.thread_last_activity,
            now=now,
        )

        if decision.permanent:
            doomed.append((candidate.row.id, f"[{decision.gate}] {decision.reason}"))
        else:
            surviving += 1

    for row_id, reason in doomed:
        print(f"{row_id}  {reason}")
        if arguments.apply:
            retire(row_id, f"retired by factory-keeper reconcile: {reason}")

    verb = "retired" if arguments.apply else "would retire"
    print(f"\n{verb} {len(doomed)} rows; {surviving} left alone")
    if not arguments.apply and doomed:
        print("dry run - nothing written. Re-run with --apply.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
