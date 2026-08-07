"""The keeper's gates, one case per gate in both directions.

A gate is only worth having if it refuses the thing it was written for and
passes everything else, so every gate here is exercised twice: once with the
condition it names, once with that condition removed and nothing else changed.
A suite that only ever asserted refusals would pass just as happily against a
keeper that refused everything, which is the failure mode that matters — a
silent halt looks exactly like a quiet week.

The fixtures at the bottom are not invented. They are the rows that produced
issue #210, transcribed from the live table: the `done` item that kept being
woken, the plan-role binding still carrying a triage payload, and the
work-role binding carrying a plan payload that is *correct* and must survive
every gate.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from factory_keeper import gates  # noqa: E402
from factory_keeper.gates import (  # noqa: E402
    Binding,
    Decision,
    PendingStart,
    WorkItem,
    should_requeue,
)

NOW = datetime(2026, 8, 7, 12, 0, 0)

#: `None` is a meaningful value for `item` — it is how a row whose work item
#: has vanished is expressed — so the helper cannot use it to mean "default".
UNSET = object()


def a_row(**overrides) -> PendingStart:
    """A row that every gate lets through, so a test can break exactly one thing."""
    fields = {
        "id": "row-1",
        "binding_id": "binding-1",
        "status": "sent",
        "attempts": 1,
        "created_at": NOW - timedelta(minutes=30),
        "message": '<skill name="factory-plan">plan the thing</skill>',
    }
    fields.update(overrides)
    return PendingStart(**fields)


def a_binding(**overrides) -> Binding:
    fields = {
        "id": "binding-1",
        "role": "plan",
        "status": "active",
        "thread_id": "thread-1",
    }
    fields.update(overrides)
    return Binding(**fields)


def an_item(**overrides) -> WorkItem:
    fields = {"id": "item-1", "stages": ("planning",)}
    fields.update(overrides)
    return WorkItem(**fields)


def decide(
    *,
    row=UNSET,
    binding=UNSET,
    item=UNSET,
    issue_state=None,
    thread_last_activity=None,
    now=NOW,
) -> Decision:
    return should_requeue(
        row=a_row() if row is UNSET else row,
        binding=a_binding() if binding is UNSET else binding,
        item=an_item() if item is UNSET else item,
        issue_state=issue_state,
        thread_last_activity=thread_last_activity,
        now=now,
    )


def test_a_genuinely_stalled_run_is_woken() -> None:
    """The case the keeper exists for: nothing wrong, nobody home."""
    decision = decide(thread_last_activity=NOW - timedelta(hours=2))

    assert decision.requeue is True
    assert decision.gate == ""


def test_a_stalled_run_with_no_thread_history_is_woken() -> None:
    """A thread that has never spoken is silent, not busy."""
    assert decide(thread_last_activity=None).requeue is True


# --- G0: the guards inherited from the original keeper ------------------------


def test_revoked_binding_is_refused() -> None:
    decision = decide(binding=a_binding(status="revoked"))

    assert decision.requeue is False
    assert decision.gate == "G0-binding-revoked"
    assert decision.permanent is True


def test_active_binding_is_not_refused_for_its_status() -> None:
    assert decide(binding=a_binding(status="active")).requeue is True


def test_row_past_the_age_horizon_is_refused() -> None:
    decision = decide(row=a_row(created_at=NOW - timedelta(hours=25)))

    assert decision.requeue is False
    assert decision.gate == "G0-row-expired"
    assert decision.permanent is True


def test_row_inside_the_age_horizon_is_not_refused_for_its_age() -> None:
    assert decide(row=a_row(created_at=NOW - timedelta(hours=23))).requeue is True


# --- G1: terminal stage -------------------------------------------------------


@pytest.mark.parametrize("stage", sorted(gates.TERMINAL_STAGES))
def test_terminal_stage_is_refused(stage: str) -> None:
    """#182 reached `done` and was woken twice more. This is that gate."""
    decision = decide(item=an_item(stages=(stage,)))

    assert decision.requeue is False
    assert decision.gate == "G1-terminal-stage"
    assert decision.permanent is True


def test_non_terminal_stage_is_not_refused_for_its_stage() -> None:
    assert decide(item=an_item(stages=("planning",))).requeue is True


def test_missing_work_item_is_refused() -> None:
    decision = decide(item=None)

    assert decision.requeue is False
    assert decision.gate == "G1-item-missing"


def test_item_on_several_boards_is_not_judged_on_stage() -> None:
    """No single stage means no stage verdict — it must fail open, not refuse."""
    decision = decide(
        item=an_item(stages=("planning", "review")),
        binding=a_binding(role="work"),
    )

    assert decision.requeue is True


# --- G2: linked issue closed --------------------------------------------------


def test_closed_issue_is_refused() -> None:
    decision = decide(issue_state="CLOSED")

    assert decision.requeue is False
    assert decision.gate == "G2-issue-closed"
    assert decision.permanent is True


def test_open_issue_is_not_refused() -> None:
    assert decide(issue_state="OPEN").requeue is True


def test_unknown_issue_state_is_not_refused() -> None:
    """A GitHub lookup that failed must not become a reason to halt work."""
    assert decide(issue_state=None).requeue is True


# --- G3: payload does not match the binding's role ----------------------------


def test_plan_binding_carrying_a_triage_payload_is_refused() -> None:
    """Twenty-three live rows looked exactly like this."""
    decision = decide(
        row=a_row(message='<skill name="factory-triage">triage it</skill>'),
        binding=a_binding(role="plan"),
    )

    assert decision.requeue is False
    assert decision.gate == "G3-payload-role-mismatch"
    assert decision.permanent is True


def test_plan_binding_carrying_a_plan_payload_is_not_refused() -> None:
    decision = decide(
        row=a_row(message='<skill name="factory-plan">plan it</skill>'),
        binding=a_binding(role="plan"),
    )

    assert decision.requeue is True


def test_work_binding_carrying_a_plan_payload_is_not_refused() -> None:
    """The live counter-example, and the reason this gate is not a role table.

    Thirteen `work` bindings carry `factory-plan` payloads because an
    execute-stage run is handed the planning skill plus a resume instruction.
    The run that implemented this gate was itself one of them. A gate that
    assumed one skill per role would have refused its own kickoff.
    """
    decision = decide(
        row=a_row(message='<skill name="factory-plan">resume and ship</skill>'),
        binding=a_binding(role="work"),
        item=an_item(stages=("execute",)),
    )

    assert decision.requeue is True


def test_payload_without_a_skill_tag_is_not_refused() -> None:
    decision = decide(row=a_row(message="wake up and look at the branch"))

    assert decision.requeue is True


# --- G4: role does not match the item's stage ---------------------------------


def test_triage_binding_at_planning_is_refused() -> None:
    """The structural half of #210: triage cannot transition past Planning."""
    decision = decide(
        row=a_row(message='<skill name="factory-triage">triage it</skill>'),
        binding=a_binding(role="triage"),
        item=an_item(stages=("planning",)),
    )

    assert decision.requeue is False
    assert decision.gate == "G4-role-stage-mismatch"
    assert decision.permanent is True


def test_triage_binding_at_triage_is_not_refused() -> None:
    decision = decide(
        row=a_row(message='<skill name="factory-triage">triage it</skill>'),
        binding=a_binding(role="triage"),
        item=an_item(stages=("triage",)),
    )

    assert decision.requeue is True


def test_unknown_role_is_not_judged_on_stage() -> None:
    decision = decide(
        row=a_row(message=None),
        binding=a_binding(role="something-new"),
        item=an_item(stages=("planning",)),
    )

    assert decision.gate != "G4-role-stage-mismatch"


# --- G5 / G6: transient refusals ----------------------------------------------


def test_row_without_a_message_is_refused_but_not_permanently() -> None:
    decision = decide(row=a_row(message=None), binding=a_binding(role="work"),
                      item=an_item(stages=("execute",)))

    assert decision.requeue is False
    assert decision.gate == "G5-no-payload"
    assert decision.permanent is False


def test_active_thread_is_refused_for_this_tick_only() -> None:
    decision = decide(thread_last_activity=NOW - timedelta(minutes=5))

    assert decision.requeue is False
    assert decision.gate == "G6-thread-active"
    assert decision.permanent is False


def test_thread_idle_past_the_window_is_woken() -> None:
    decision = decide(thread_last_activity=NOW - gates.ACTIVITY_WINDOW - timedelta(minutes=1))

    assert decision.requeue is True


def test_activity_window_outlasts_the_cron_interval() -> None:
    """A run answering on every tick must never be woken twice for one silence."""
    assert gates.ACTIVITY_WINDOW > timedelta(minutes=15)


def test_permanent_refusal_wins_over_a_busy_thread() -> None:
    """Ordering that `reconcile` depends on.

    A dead row whose thread happens to be active must still report as dead,
    or the one-shot would never retire it and it would loop forever.
    """
    decision = decide(
        item=an_item(stages=("done",)),
        thread_last_activity=NOW - timedelta(minutes=1),
    )

    assert decision.gate == "G1-terminal-stage"
    assert decision.permanent is True


# --- the rows that produced the issue ----------------------------------------


def test_regression_issue_182_done_item_is_never_woken_again() -> None:
    """Work item dbd2cb97, stage `done`, seventeen accumulated rows."""
    decision = decide(
        row=a_row(
            id="b3e7a631-9914",
            message='<skill name="factory-triage">triage it</skill>',
        ),
        binding=a_binding(id="binding-182", role="triage"),
        item=WorkItem(id="dbd2cb97-561e-438c-97f3-5e5258701117", stages=("done",)),
        issue_state="CLOSED",
    )

    assert decision.requeue is False
    assert decision.permanent is True


def test_regression_issue_210_planning_item_refuses_triage_payload() -> None:
    """Row 5f73bf93 on a plan binding, still carrying factory-triage text."""
    decision = decide(
        row=a_row(
            id="5f73bf93-615f-4269-b4cd-a50e1857ca76",
            message='<skill name="factory-triage">triage it</skill>',
        ),
        binding=a_binding(id="2ba70c6d-15e5-4439-8f05-093d83c91c4e", role="plan"),
        item=WorkItem(id="34c78273-df61-439d-949c-a9de158c8a9a", stages=("planning",)),
        issue_state="OPEN",
    )

    assert decision.requeue is False
    assert decision.gate == "G3-payload-role-mismatch"
    assert decision.permanent is True


def test_regression_this_very_run_would_have_been_woken() -> None:
    """The kickoff that implemented this gate must survive it.

    A work-role binding at `execute`, carrying a factory-plan payload, on an
    open issue, after a server restart left the thread silent. If this returns
    False the keeper has gated away the only case it is still for.
    """
    decision = decide(
        row=a_row(message='<skill name="factory-plan">resume and ship</skill>'),
        binding=a_binding(id="binding-210-work", role="work"),
        item=WorkItem(id="34c78273-df61-439d-949c-a9de158c8a9a", stages=("execute",)),
        issue_state="OPEN",
        thread_last_activity=NOW - timedelta(hours=4),
    )

    assert decision.requeue is True


def test_every_refusal_names_its_gate_and_reason() -> None:
    """A skip nobody can read is the outage this suite is meant to prevent."""
    refusals = [
        decide(binding=a_binding(status="revoked")),
        decide(row=a_row(created_at=NOW - timedelta(hours=25))),
        decide(item=an_item(stages=("done",))),
        decide(issue_state="CLOSED"),
        decide(
            row=a_row(message='<skill name="factory-triage">t</skill>'),
            binding=a_binding(role="plan"),
        ),
        decide(
            row=a_row(message='<skill name="factory-triage">t</skill>'),
            binding=a_binding(role="triage"),
        ),
        decide(thread_last_activity=NOW - timedelta(minutes=5)),
    ]

    for decision in refusals:
        assert decision.requeue is False
        assert decision.gate, "a refusal with no gate cannot be diagnosed"
        assert decision.reason, "a refusal with no reason cannot be diagnosed"
        assert decision.log_line("row-1").startswith("skip row-1 [")
