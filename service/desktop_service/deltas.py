"""What changed, who caused it, and who is asking.

The service keeps one authoritative picture of the desktop and stamps every change it
observes with the session revision. Callers never receive events; they receive a
*semantic diff* — "since revision 41: a window opened, focus moved to it" — which is the
same information at a fraction of the tokens and, more importantly, at a granularity a
reader can act on.

Three properties this module exists to hold:

**One engine, several consumers.** The same changes feed the pull method, the pushed
signal, and the effects reported on an action's own result. Separate implementations
would each be self-consistent and would quietly disagree; a disagreement between two
diffs of the same desktop is undetectable from inside either one.

**Attribution is per-asker, and it is decided at read time.** "Self" is not a property of
a change, it is a relationship between a change and whoever is asking about it. With two
clients driving one desktop — the design this project is heading for — the very same
window opening is a consequence to the client that acted and news to the other. Deciding
attribution when the change is recorded would bake in one asker forever.

**There is an honest third answer.** A change inside an action's revision range but
outside its causal scope is reported as `unattributed`, not quietly claimed as self and
not confidently called external. A human who opens a window while the agent is acting
lands exactly there, and pretending otherwise is how an agent comes to believe it caused
things it did not.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Callable

from . import actions, state


@dataclass(frozen=True)
class LoggedChange:
    """A change as it was observed, before anyone asked about it."""

    revision: int
    change: dict[str, Any]


class ChangeLog:
    """The recent history of the desktop, bounded.

    Bounded because this is a working set, not an audit trail: a consumer that has fallen
    further behind than the log reaches is told so — with the oldest revision still held —
    rather than being handed a silently incomplete answer.
    """

    def __init__(self, limit: int = 1024) -> None:
        self._entries: list[LoggedChange] = []
        self._limit = limit
        self._dropped_through: int = -1

    def append(self, revision: int, change: dict[str, Any]) -> None:
        self._entries.append(LoggedChange(revision=revision, change=change))
        if len(self._entries) > self._limit:
            overflow = len(self._entries) - self._limit
            self._dropped_through = self._entries[overflow - 1].revision
            del self._entries[:overflow]

    def since(self, revision: int) -> list[LoggedChange]:
        return [entry for entry in self._entries if entry.revision > revision]

    def covers(self, revision: int) -> bool:
        """Whether a caller at this revision can still be told everything it missed."""
        return revision >= self._dropped_through

    @property
    def resume_revision(self) -> int:
        """The earliest cursor that still yields everything the log holds.

        A caller told its answer is incomplete needs a number it can act on, and `since` is
        exclusive: handing back the oldest revision still *held* would make the caller skip
        the very change at that revision. This is the last revision that fell off the end,
        so asking from it returns everything left.
        """
        return max(self._dropped_through, 0)

    def __len__(self) -> int:
        return len(self._entries)


#: A change nobody claims. Not a hedge — the plain statement that the desktop moved and
#: no action of this session can account for it.
EXTERNAL = "external"
#: In an action's revision range and in its causal scope: a consequence of that act.
SELF = "self"
#: In the range, out of the scope. Something happened during the action that the action
#: probably did not cause.
UNATTRIBUTED = "unattributed"


def attribute(
    change: dict[str, Any],
    revision: int,
    log: actions.ActionLog,
    asking_client: str = "",
) -> dict[str, Any]:
    """Label one change for one asker.

    The two conditions are deliberately separate. Falling inside an action's revision
    range makes a change a *candidate*; falling inside that action's causal scope is what
    makes it a consequence. A rule that used only the range would attribute anything that
    happened while the agent was busy to the agent, which is worse than saying nothing.

    An action taken by a *different* client is external to this asker — it did not do it —
    but the change still carries who did, because "another agent moved this" and "a human
    moved this" call for different responses.
    """
    labelled = dict(change)
    candidates = [record for record in log.covering(revision) if record.in_scope(change)]
    if not candidates:
        in_range = log.covering(revision)
        labelled["attribution"] = UNATTRIBUTED if in_range else EXTERNAL
        return labelled

    record = candidates[-1]
    mine = record.client_id == asking_client
    labelled["attribution"] = SELF if mine else EXTERNAL
    detail = dict(labelled.get("detail") or {})
    detail["causedBy"] = record.action_id
    if record.client_id:
        detail["causedByClientId"] = record.client_id
    labelled["detail"] = detail
    return labelled


class DeltaEngine:
    """The authoritative picture, and the one place changes to it are computed.

    `observe` is called with a fresh snapshot from whatever noticed the desktop moved —
    an accessibility event, the reconciliation sweep, or the settling wait after an
    action. All three paths converge here, so a change is recorded once no matter how
    many observers saw it.
    """

    def __init__(
        self,
        log: actions.ActionLog,
        change_log: ChangeLog | None = None,
        advance: Callable[[], int] | None = None,
    ) -> None:
        self._action_log = log
        # `is None`, not `or`: an empty ChangeLog is falsy, so `or` would discard a
        # caller's log — including a deliberately small one — for a fresh default.
        self._changes = ChangeLog() if change_log is None else change_log
        self._current = state.Snapshot(revision=0)
        self._advance = advance

    @property
    def current(self) -> state.Snapshot:
        return self._current

    @property
    def resume_revision(self) -> int:
        return self._changes.resume_revision

    def observe(self, snapshot: state.Snapshot) -> list[dict[str, Any]]:
        """Fold a new observation into the picture and record what it changed.

        The revision advances here, and only when something actually changed. A counter
        that ticked on every observation would make "nothing happened" indistinguishable
        from "something happened" to anyone holding a cursor; one that never ticked would
        make every delta cursor permanently deaf, because `since` is exclusive.

        Returns the raw changes. They are deliberately unattributed here: attribution
        belongs to whoever asks, and this method does not know who that will be.
        """
        changes = state.diff(self._current, snapshot)
        # The revision is the engine's, never the sampler's. Taking the incoming snapshot's
        # number would let a quiet observation walk the counter backwards, and a cursor
        # handed out before that would silently start matching changes it had already seen.
        if changes and self._advance is not None:
            revision = self._advance()
        else:
            revision = max(snapshot.revision, self._current.revision)
        self._current = replace(snapshot, revision=revision)
        snapshot = self._current
        for change in changes:
            change["revision"] = snapshot.revision
            self._changes.append(snapshot.revision, change)
        return changes

    def since(self, revision: int, asking_client: str = "") -> dict[str, Any]:
        """Everything this asker has not been told, labelled for this asker.

        `complete` is false when the caller has fallen behind the bounded log. A caller
        told `complete: false` knows to re-read rather than to assume the quiet was real —
        an incomplete delta that looked complete would be a lie that reads like calm.
        """
        entries = self._changes.since(revision)
        return {
            "changes": [
                attribute(entry.change, entry.revision, self._action_log, asking_client)
                for entry in entries
            ],
            "revision": self._current.revision,
            "complete": self._changes.covers(revision),
        }
