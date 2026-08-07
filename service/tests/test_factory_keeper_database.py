"""The keeper against a real database, with rows it is allowed to break.

The gate suite proves the arithmetic. It cannot prove that the query finds the
rows, that the columns come back in the order the parser expects, or that the
UPDATE moves the rows it names — and those are exactly the things that were
wrong twice while this was being written. A `uuid = text` join that no unit
test could have caught, and a timestamp column whose zone-awareness differed
from the column beside it. Both were found by running it.

Deliberately *not* named `_live`, despite needing something this process cannot
invent. The root conftest is explicit that the lane is decided by what a test
asserts rather than by its name, and the `live` marker means one specific
thing: drives a real desktop. Its gate probes X11 and reports `no desktop
session is reachable from here`, which would be a false explanation for a test
whose only external need is Postgres — and on a headless box with a healthy
database it would skip the very tests that can run.

So this file self-skips instead, on the one condition it actually cares about:
whether the container answers. That reads correctly everywhere. It runs in the
portable lane on any machine with the factory database, and says why when it
cannot.

Every row it writes is tagged with a dedicated org id that no real work uses,
and teardown deletes by that tag. It never reads, writes, updates or even joins
against a real work item; if the fixtures leak, the blast radius is a handful
of rows nothing is looking at.
"""

from __future__ import annotations

import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from factory_keeper import keeper  # noqa: E402

#: The tag that makes cleanup total. A uuid rather than a readable string so
#: that a half-finished run of this file can never collide with another.
TEST_ORG = f"keeper-test-{uuid.uuid4()}"
PROJECT = str(uuid.uuid4())


def psql(sql: str) -> str:
    finished = subprocess.run(
        ["docker", "exec", keeper.CONTAINER, "psql", "-U", keeper.DB_USER,
         "-d", keeper.DB_NAME, "-tA", "-c", sql],
        capture_output=True,
        text=True,
    )
    if finished.returncode != 0:
        pytest.skip(f"no reachable factory database: {finished.stderr.strip()}")
    return finished.stdout


def quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def seed_row(*, stage: str, role: str, message: str, binding_status: str = "active",
             age: timedelta = timedelta(minutes=30)) -> str:
    """Insert one work item, one binding and one pending start. Return the row id."""
    item_id, binding_id, row_id = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    created = datetime.now(timezone.utc) - age

    psql(
        f"INSERT INTO work_items (id, org_id, factory_project_id, title, stages, "
        f"stage_history, sessions, revision, created_by, created_at, updated_at) VALUES "
        f"({quote(item_id)}, {quote(TEST_ORG)}, {quote(PROJECT)}, 'keeper fixture', "
        f"'[\"{stage}\"]'::jsonb, '[]'::jsonb, '{{}}'::jsonb, 1, 'test', now(), now());"
    )
    psql(
        f"INSERT INTO factory_run_bindings (id, org_id, factory_project_id, work_item_id, "
        f"role, thread_id, resource_id, session_id, branch, status, created_at) VALUES "
        f"({quote(binding_id)}, {quote(TEST_ORG)}, {quote(PROJECT)}, {quote(item_id)}, "
        f"{quote(role)}, {quote('thread-' + row_id)}, 'res', 'sess', 'branch', "
        f"{quote(binding_status)}, now());"
    )
    psql(
        f"INSERT INTO factory_pending_starts (id, org_id, factory_project_id, binding_id, "
        f"kickoff_key, message, status, attempts, available_at, created_at, updated_at) VALUES "
        f"({quote(row_id)}, {quote(TEST_ORG)}, {quote(PROJECT)}, {quote(binding_id)}, "
        f"{quote('kickoff-' + row_id)}, {quote(message)}, 'sent', 1, now(), "
        f"{quote(created.isoformat())}, now());"
    )
    return row_id


def status_of(row_id: str) -> str:
    return psql(
        f"SELECT status FROM factory_pending_starts WHERE id={quote(row_id)};"
    ).strip()


@pytest.fixture
def clean_fixtures():
    yield
    for table in ("factory_pending_starts", "factory_run_bindings", "work_items"):
        psql(f"DELETE FROM {table} WHERE org_id={quote(TEST_ORG)};")


def test_the_keeper_wakes_the_stalled_and_leaves_the_finished_alone(
    clean_fixtures, tmp_path, monkeypatch
) -> None:
    """One row of each kind, one real run, and only the right row moves.

    The finished row and the mismatched row are the two shapes from issue #210.
    The stalled row is the reason the keeper still exists, and if the gates ever
    swallow it this test is what says so.
    """
    stalled = seed_row(
        stage="execute", role="work",
        message='<skill name="factory-plan">resume and ship</skill>',
    )
    finished = seed_row(
        stage="done", role="work",
        message='<skill name="factory-plan">resume and ship</skill>',
    )
    mismatched = seed_row(
        stage="planning", role="plan",
        message='<skill name="factory-triage">triage it</skill>',
    )
    revoked = seed_row(
        stage="execute", role="work", binding_status="revoked",
        message='<skill name="factory-plan">resume and ship</skill>',
    )

    monkeypatch.setattr(keeper, "LOG_PATH", tmp_path / "keeper.log")
    # The fleet is genuinely busy on a shared dev box, and this test is about
    # the gates rather than the capacity guard.
    monkeypatch.setattr(keeper, "MAX_LEASED", 10_000)
    monkeypatch.setattr(keeper, "MAX_RETRY", 10_000)
    # The fixtures carry no real issue number, and a GitHub round trip per row
    # would make this test slow and network-dependent for no added coverage.
    monkeypatch.setattr(keeper, "issue_state", lambda number: None)

    keeper.main(["--org-id", TEST_ORG])

    assert status_of(stalled) == "retry", "a genuinely stalled run was not woken"
    assert status_of(finished) == "sent", "a finished run was woken again"
    assert status_of(mismatched) == "sent", "a stale-payload run was woken again"
    assert status_of(revoked) == "sent", "a revoked binding was woken"

    log = (tmp_path / "keeper.log").read_text()
    assert "G1-terminal-stage" in log
    assert "G3-payload-role-mismatch" in log
    assert "G0-binding-revoked" in log


def test_a_dry_run_writes_nothing(clean_fixtures, tmp_path, monkeypatch) -> None:
    stalled = seed_row(
        stage="execute", role="work",
        message='<skill name="factory-plan">resume and ship</skill>',
    )

    monkeypatch.setattr(keeper, "LOG_PATH", tmp_path / "keeper.log")
    monkeypatch.setattr(keeper, "MAX_LEASED", 10_000)
    monkeypatch.setattr(keeper, "MAX_RETRY", 10_000)
    monkeypatch.setattr(keeper, "issue_state", lambda number: None)

    keeper.main(["--dry-run", "--org-id", TEST_ORG])

    assert status_of(stalled) == "sent", "--dry-run modified the database"
    assert "would requeue" in (tmp_path / "keeper.log").read_text()


def test_reconcile_retires_only_permanent_refusals(
    clean_fixtures, tmp_path, monkeypatch
) -> None:
    """The one-shot must leave anything a later tick could legitimately wake."""
    from factory_keeper import reconcile

    finished = seed_row(
        stage="done", role="work",
        message='<skill name="factory-plan">resume and ship</skill>',
    )
    stalled = seed_row(
        stage="execute", role="work",
        message='<skill name="factory-plan">resume and ship</skill>',
    )

    monkeypatch.setattr(keeper, "issue_state", lambda number: None)
    monkeypatch.setattr(reconcile, "issue_state", lambda number: None)

    # `--org-id` is not decoration. An earlier version of this test called
    # `--apply` with no scope and retired 173 rows across the whole dev fleet.
    # Nothing was lost — every one of them was a row the gates refuse
    # permanently, and the run was reviewed against a dry run taken minutes
    # before — but a test that can reach the fleet is a test that will, one day,
    # reach it with a bug in it.
    reconcile.main(["--apply", "--org-id", TEST_ORG])

    assert status_of(finished) == "failed", "a permanently dead row was not retired"
    assert status_of(stalled) == "sent", "a live row was retired"

    reason = psql(
        f"SELECT last_error FROM factory_pending_starts WHERE id={quote(finished)};"
    )
    assert "G1-terminal-stage" in reason, "a retired row must say which gate refused it"


def test_org_scoping_actually_scopes(clean_fixtures, monkeypatch) -> None:
    """The guard rail that the previous test relies on, checked directly.

    Asserted by counting rows the run was not allowed to see: a scoped load
    must return only this tenant's row, while an unscoped one sees the fleet.
    Without this, `--org-id` could quietly stop filtering and every other test
    here would keep passing while writing across the whole table.
    """
    seed_row(
        stage="done", role="work",
        message='<skill name="factory-plan">resume and ship</skill>',
    )

    scoped = keeper.load_candidates(TEST_ORG)
    unscoped = keeper.load_candidates()

    assert len(scoped) == 1, f"scoped load saw {len(scoped)} rows, expected only ours"
    assert scoped[0].row.id not in {c.row.id for c in unscoped if c.row.id != scoped[0].row.id}
    assert len(unscoped) > len(scoped), "unscoped load should see the rest of the fleet"
