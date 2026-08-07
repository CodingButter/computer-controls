"""Whether a stalled Factory run should be woken again, decided without touching
a database.

The keeper exists because a Factory run can die quietly — a server restart, a
lost lease, a turn that never came back — and leave its work item sitting on a
non-terminal stage with nobody coming to move it. Re-waking it is the right
answer to that.

It is the wrong answer to everything else, and the original keeper could not
tell the difference. It asked two questions: is anything in flight, and is there
a row that was already sent. Both are true for a run that finished perfectly, so
it re-woke those too, every fifteen minutes, for as long as the row survived.
Issue #210 is what that looks like from the receiving end: nine identical triage
kickoffs for work that had shipped, its issue closed and both PRs merged.

So the decision moved here, where it can be examined. Every refusal names the
gate that produced it, because a keeper that silently declines to wake anything
is indistinguishable from a keeper that is broken, and this repository has
already shipped one commit whose message is `stop the two faults that silently
halted all issue work`. Loud refusals are the difference between a gate and an
outage.

Two kinds of refusal, and the distinction is load-bearing:

*Permanent* means no future tick can change the answer — the item reached a
terminal stage, the issue closed, the payload is addressed to a stage the run is
already past. ``reconcile`` retires exactly these, and nothing else.

*This tick* means the answer is expected to change — somebody is mid-turn in the
bound thread right now. Waking them would interrupt work that is already
happening, but twenty minutes from now the same row may genuinely need it.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta

#: Stages from which no run is ever coming back. The gate that reads these is
#: the one that would have spared issue #182 its last two kickoffs, both of
#: which arrived after the item was already `done`.
TERMINAL_STAGES = frozenset({"done", "canceled"})

#: Which skills a binding of a given role may legitimately be dispatched.
#:
#: Only roles with an unambiguous mapping appear here, and the omission of
#: `work` is a measurement rather than an oversight. The live table has
#: `work`-role bindings carrying `factory-plan` payloads — thirteen of them, in
#: `leased`, `pending` and `sent` — because an execute-stage run is handed the
#: planning skill plus a resume instruction. A role whose correct payload cannot
#: be stated is not judged at all; see ``_skill_is_wrong_for_role``.
ROLE_SKILLS: dict[str, frozenset[str]] = {
    "triage": frozenset({"factory-triage"}),
    "plan": frozenset({"factory-plan"}),
    "review": frozenset({"factory-review"}),
}

#: Which stages a binding of a given role still has business waking.
#:
#: A triage kickoff for an item at `planning` cannot advance anything: the
#: factory-triage skill's own stage clause forbids it from requesting a
#: transition once the item is past Planning, so the run it starts is
#: structurally unable to end. That is the shape of #210, and this map is what
#: refuses it.
ROLE_STAGES: dict[str, frozenset[str]] = {
    "triage": frozenset({"intake", "triage"}),
    "plan": frozenset({"planning"}),
    "work": frozenset({"execute"}),
    "review": frozenset({"review"}),
}

#: A row older than this is not a stalled run, it is litter. Inherited from the
#: original keeper unchanged.
MAX_ROW_AGE = timedelta(hours=24)

#: How recently the bound thread must have spoken for a wake to count as an
#: interruption. Longer than the fifteen-minute cron deliberately: a run that
#: answers on every tick must never be woken twice for the same silence.
ACTIVITY_WINDOW = timedelta(minutes=20)

#: The dispatcher skips rows with no message, so requeuing one buys nothing.
_SKILL_RE = re.compile(r'<skill name="([^"]+)">')


@dataclass(frozen=True)
class PendingStart:
    """The row under consideration."""

    id: str
    binding_id: str
    status: str
    attempts: int
    created_at: datetime
    message: str | None = None
    skill: str | None = None

    def dispatched_skill(self) -> str | None:
        """The skill this row will dispatch when it is next delivered.

        Read from the payload rather than inferred from the role, because the
        payload is frozen when the run start is prepared and the item's stage
        can move afterwards. That gap is the defect; reading both is how the
        mismatch becomes visible.
        """
        if self.skill:
            return self.skill
        if not self.message:
            return None
        found = _SKILL_RE.search(self.message)
        return found.group(1) if found else None


@dataclass(frozen=True)
class Binding:
    """The run binding the row belongs to."""

    id: str
    role: str
    status: str
    thread_id: str | None = None


@dataclass(frozen=True)
class WorkItem:
    """The work item the binding is bound to."""

    id: str
    stages: tuple[str, ...]

    @classmethod
    def from_json(cls, item_id: str, stages: str | None) -> "WorkItem":
        """Build from the `stages` jsonb column as psql renders it."""
        if not stages:
            return cls(id=item_id, stages=())
        parsed = json.loads(stages)
        return cls(id=item_id, stages=tuple(str(stage) for stage in parsed))

    def current_stage(self) -> str | None:
        """The single stage an item sits on, or None when it is on several.

        A card on more than one board has no one answer, and guessing would put
        the gates in the business of resolving multi-board state. They refuse to
        judge instead, which fails open.
        """
        return self.stages[0] if len(self.stages) == 1 else None


@dataclass(frozen=True)
class Decision:
    """Why the keeper did or did not wake a run."""

    requeue: bool
    gate: str
    reason: str
    permanent: bool = False

    def log_line(self, row_id: str) -> str:
        verdict = "requeue" if self.requeue else "skip"
        return f"{verdict} {row_id} [{self.gate}] {self.reason}"


def should_requeue(
    *,
    row: PendingStart,
    binding: Binding,
    item: WorkItem | None,
    issue_state: str | None,
    thread_last_activity: datetime | None,
    now: datetime,
) -> Decision:
    """Decide one row. No I/O, no clock, no database — every input is passed in.

    The order of the gates is not arbitrary. The cheap structural facts come
    first so that a row refused for being litter never causes a GitHub lookup,
    and the interruption check comes last so that a row which is permanently
    dead is reported as permanently dead even while somebody is typing in its
    thread. ``reconcile`` depends on that ordering: it retires on
    ``permanent``, and a permanent verdict masked by a transient one would
    leave the row to loop forever.
    """
    if binding.status != "active":
        return Decision(
            requeue=False,
            gate="G0-binding-revoked",
            reason=f"binding {binding.id} is {binding.status}, not active",
            permanent=True,
        )

    age = now - row.created_at
    if age > MAX_ROW_AGE:
        return Decision(
            requeue=False,
            gate="G0-row-expired",
            reason=f"row is {age} old, past the {MAX_ROW_AGE} horizon",
            permanent=True,
        )

    if item is None:
        return Decision(
            requeue=False,
            gate="G1-item-missing",
            reason=f"binding {binding.id} has no work item to advance",
            permanent=True,
        )

    stage = item.current_stage()

    if stage in TERMINAL_STAGES:
        return Decision(
            requeue=False,
            gate="G1-terminal-stage",
            reason=f"work item {item.id} is {stage}; no run is coming back",
            permanent=True,
        )

    if issue_state and issue_state.upper() == "CLOSED":
        return Decision(
            requeue=False,
            gate="G2-issue-closed",
            reason=f"linked issue for {item.id} is closed",
            permanent=True,
        )

    dispatched = row.dispatched_skill()
    if _skill_is_wrong_for_role(binding.role, dispatched):
        expected = "/".join(sorted(ROLE_SKILLS[binding.role]))
        return Decision(
            requeue=False,
            gate="G3-payload-role-mismatch",
            reason=(
                f"{binding.role} binding carries {dispatched}, expected {expected}; "
                "the payload froze before the item moved"
            ),
            permanent=True,
        )

    if _role_is_wrong_for_stage(binding.role, stage):
        allowed = "/".join(sorted(ROLE_STAGES[binding.role]))
        return Decision(
            requeue=False,
            gate="G4-role-stage-mismatch",
            reason=(
                f"{binding.role} binding woken at stage {stage}; "
                f"it can only act at {allowed}"
            ),
            permanent=True,
        )

    if row.message is None:
        return Decision(
            requeue=False,
            gate="G5-no-payload",
            reason="row has no message; the dispatcher would skip it anyway",
        )

    if thread_last_activity is not None:
        idle_for = now - thread_last_activity
        if idle_for < ACTIVITY_WINDOW:
            return Decision(
                requeue=False,
                gate="G6-thread-active",
                reason=(
                    f"thread {binding.thread_id} spoke {idle_for} ago; "
                    "waking it would interrupt a live run"
                ),
            )

    return Decision(
        requeue=True,
        gate="",
        reason=f"{binding.role} run for {item.id} at {stage} is stalled",
    )


def _skill_is_wrong_for_role(role: str, skill: str | None) -> bool:
    """True only when the role has a known payload and this is not it.

    Both unknowns fail open. A role absent from ``ROLE_SKILLS`` is one whose
    correct payload has not been established — `work` is the live example — and
    a row whose message carries no skill tag at all is not evidence of a
    mismatch. Refusing either would gate on ignorance.
    """
    allowed = ROLE_SKILLS.get(role)
    if allowed is None or skill is None:
        return False
    return skill not in allowed


def _role_is_wrong_for_stage(role: str, stage: str | None) -> bool:
    """True only when the role has known stages and the item is not on them."""
    allowed = ROLE_STAGES.get(role)
    if allowed is None or stage is None:
        return False
    return stage not in allowed
