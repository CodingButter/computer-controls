"""Who owns an element while it is being written.

A write to an element is not one event. Typing is a word at a time, and an edit
is a search, a deletion and an insertion, each its own short trip onto the
toolkit thread. The loop serializes those trips individually and nothing above
it serializes the sequence, so two writers aimed at the same field produce text
neither of them asked for — and both are told it worked, because each one's
inserts really were accepted. Interleaved text is worse than a refusal
precisely because it looks like a success.

So an element is *owned* for the length of a write. The second writer is
refused and told who holds it. It is not queued: a queue would hold a request
open for however long a paced sentence takes and then apply it to a field whose
contents have changed underneath it, which is a different wrong answer arrived
at more slowly.

Two rules follow from the shape of the problem rather than from taste:

- Ownership is per element, never per application. Two agents working in one
  window is the case this service exists to support; two agents in one text
  field is the case it exists to prevent.
- The rule lives under `actions.perform`, not in a client. A guarantee a caller
  can decline to use is not a guarantee, and there is nothing to stop a script,
  a test or a second connection from calling the service directly.
"""

from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator

from . import cadence, errors, identity, protocol_generated

#: The claim verbs are edit-class — they change who may write, so they are gated
#: like a write — but they are not themselves writes. Excluded by name because
#: the alternative is a method that must own an element before it is allowed to
#: ask to own it.
_CLAIM_METHODS = frozenset({"claimElement", "releaseElement"})

#: The methods that write into an element, derived from the operation class the
#: protocol already assigns them rather than listed here. A list would be a
#: second place to remember, and the method that got forgotten in it would be
#: the one that quietly went unowned.
WRITE_METHODS = frozenset(
    method
    for method, operation_class in protocol_generated.OPERATION_CLASS.items()
    if operation_class == "edit" and method not in _CLAIM_METHODS
)

#: Added to a caller's own estimate to get its lease. Work finishes a little
#: after the typing does — a read-back, a settle, an answer travelling back down
#: a socket — and a lease that expires in that gap would take the element away
#: from a write that had all but succeeded.
CLAIM_MARGIN_MS = 2_000

#: What a claim gets when the caller says nothing about the work. Long enough
#: for a sentence, short enough that a client which forgets to release does not
#: hold a field hostage for the length of a session.
DEFAULT_LEASE_MS = 30_000

#: The ceiling the protocol already states. A lease nobody can outlive is
#: ownership wearing a lease's name.
MAX_LEASE_MS = 600_000

#: How many expiries we remember, so that a client whose claim ran out is told
#: so once rather than silently continuing. Bounded: this is a courtesy, and a
#: courtesy that grows without limit is a leak.
_EXPIRY_LEDGER_MAX = 256


@dataclass(frozen=True)
class Hold:
    """One writer's ownership of one element.

    Two shapes, one type. A hold taken by a write lasts exactly as long as that
    write and has no lease: it cannot outlive the call that took it. A hold
    taken by `claimElement` is a *claim* — it spans however many calls the
    caller needs and is bounded instead by a lease sized from the work it was
    taken for. The difference matters at exactly two moments: whether the
    owner's own next write is let through, and whether time can end it.
    """

    element_id: str
    client_id: str
    client_label: str
    method: str
    since: float
    lease_ms: int | None = None
    reason: str = ""

    @property
    def claimed(self) -> bool:
        """True when a caller asked for this, rather than a write taking it."""
        return self.lease_ms is not None

    def held_for_ms(self) -> int:
        return int((time.monotonic() - self.since) * 1000)

    def expires_in_ms(self) -> int:
        """Time left on the lease. Zero for a hold that time cannot end."""
        if self.lease_ms is None:
            return 0
        return max(0, self.lease_ms - self.held_for_ms())

    def expired(self) -> bool:
        return self.lease_ms is not None and self.held_for_ms() >= self.lease_ms


def lease_for(
    estimated_work_ms: int | None = None,
    *,
    for_text: str | None = None,
    words_per_minute: int | None = None,
) -> int:
    """How long a claim should last, given what it was taken for.

    A caller can say how long it thinks its work will take, or hand over the
    text it is about to type and let the lease be computed with the same
    arithmetic the typing will use. The second is the honest one: an estimate a
    client made up can drift away from the work, and one derived from the work
    cannot.

    Either way the margin goes on top, and the ceiling goes over everything.
    """
    if for_text is not None:
        wpm = words_per_minute if words_per_minute is not None else cadence.DEFAULT_WPM
        estimated_work_ms = cadence.estimate_ms(for_text, wpm)
    if estimated_work_ms is None:
        return DEFAULT_LEASE_MS
    return min(MAX_LEASE_MS, estimated_work_ms + CLAIM_MARGIN_MS)


_holds: dict[str, Hold] = {}
#: (client, element) pairs whose claim ran out rather than being given back, so
#: the client that estimated badly hears about it on its next write instead of
#: discovering it as a stranger's ELEMENT_HELD later on.
_expired: dict[tuple[str, str], float] = {}
#: Guards `_holds` only. It is never held across a call onto the GLib loop, so
#: it cannot take part in a deadlock with the thread that owns the toolkit.
_lock = threading.Lock()


def _live(element_id: str) -> Hold | None:
    """The hold on an element, dropping it first if its lease has run out.

    Expiry is noticed on the way past rather than by a timer. A lease that has
    run out has already stopped protecting anything; the only question is who
    finds out, and the answer should be whoever asks next.

    Callers hold `_lock`.
    """
    existing = _holds.get(element_id)
    if existing is None:
        return None
    if not existing.expired():
        return existing
    del _holds[element_id]
    if len(_expired) >= _EXPIRY_LEDGER_MAX:
        oldest = min(_expired, key=_expired.__getitem__)
        del _expired[oldest]
    _expired[(existing.client_id, element_id)] = time.monotonic()
    return None


def holder(element_id: str) -> Hold | None:
    """Who owns this element right now, if anyone."""
    with _lock:
        return _live(element_id)


def claim(
    element_id: str,
    client_id: str,
    *,
    lease_ms: int,
    reason: str = "",
) -> Hold:
    """Take an element for longer than one call, or be refused by its owner.

    This is the verb behind the rule that an agent may not write to an element
    it has not claimed. A write takes its own claim for its own duration, so the
    rule is never violated by a caller that does not know about this method;
    what this adds is ownership that spans calls — read the field, decide, type
    into it — during which nobody else can be mid-sentence in it.

    Re-claiming an element you already hold extends it. That is the honest thing
    to do with a client that has more work than it estimated: the alternative is
    telling it that it is in its own way.
    """
    lease = max(1, min(MAX_LEASE_MS, lease_ms))
    with _lock:
        existing = _live(element_id)
        if existing is not None and existing.client_id != client_id:
            raise errors.ElementHeld(
                element_id,
                held_by=existing.client_id,
                held_by_label=existing.client_label,
                held_method=existing.method,
                held_for_ms=existing.held_for_ms(),
            )
        held = Hold(
            element_id=element_id,
            client_id=client_id,
            client_label=identity.current_label(),
            method="claimElement",
            since=time.monotonic(),
            lease_ms=lease,
            reason=reason,
        )
        _holds[element_id] = held
        _expired.pop((client_id, element_id), None)
        return held


def lapsed(element_id: str, client_id: str) -> bool:
    """Did this client's claim on this element run out rather than end?

    Asked once, by the write that arrives after it. Reporting it twice would
    turn one bad estimate into a stream of errors about the past.
    """
    with _lock:
        return _expired.pop((client_id, element_id), None) is not None


def acquire(element_id: str, client_id: str, method: str) -> Hold:
    """Take ownership of an element, or refuse because somebody else has it.

    Exclusive without regard to who is asking. A connection is served one
    request at a time, so a client cannot collide with itself over a socket;
    where it can — a process calling the handlers directly on two threads — the
    text interleaves exactly as badly as it would between strangers.
    """
    hold = Hold(
        element_id=element_id,
        client_id=client_id,
        client_label=identity.current_label(),
        method=method,
        since=time.monotonic(),
    )
    with _lock:
        existing = _live(element_id)
        if existing is None:
            _holds[element_id] = hold
            return hold
        if existing.client_id == client_id and existing.claimed:
            # Writing inside your own claim. The claim is what let you in; it
            # is not replaced by the write and does not end when the write does.
            return existing
    raise errors.ElementHeld(
        element_id,
        held_by=existing.client_id,
        held_by_label=existing.client_label,
        held_method=existing.method,
        held_for_ms=existing.held_for_ms(),
    )


def release(element_id: str, *, holder_id: str | None = None) -> Hold | None:
    """Give an element up. Returns the hold that was released, if any.

    `holder_id` is how a writer releases its own hold and only its own: a write
    that has already been preempted must not, on finishing, release the hold
    that was taken from it. Omitting it releases regardless of owner, which is
    what preemption itself needs.
    """
    with _lock:
        existing = _holds.get(element_id)
        if existing is None:
            return None
        if holder_id is not None and existing.client_id != holder_id:
            return None
        del _holds[element_id]
        return existing


def release_all(client_id: str) -> list[str]:
    """Drop every hold belonging to a client. Returns the elements freed.

    Called when a connection ends. A client that disconnects mid-write is not
    coming back to release anything, and an element owned by a process that no
    longer exists is owned forever.
    """
    with _lock:
        freed = [
            element_id
            for element_id, hold in _holds.items()
            if hold.client_id == client_id
        ]
        for element_id in freed:
            del _holds[element_id]
    return freed


@contextmanager
def for_write(method: str, element_id: str, client_id: str) -> Iterator[Hold | None]:
    """Own the element for the length of a write; nothing at all for anything else.

    Focusing a window or invoking a button is one call that either happens or
    does not. There is no half-finished state for a second caller to land in
    the middle of, so nothing is owned and both callers proceed.
    """
    if method not in WRITE_METHODS or not element_id:
        yield None
        return
    if lapsed(element_id, client_id):
        raise errors.ClaimExpired(element_id)
    hold = acquire(element_id, client_id, method)
    try:
        yield hold
    finally:
        # A claim outlives the write that happened inside it. Releasing here
        # would hand the element to somebody else between two calls the caller
        # thinks of as one piece of work, which is the whole thing a claim
        # exists to prevent.
        if not hold.claimed:
            release(element_id, holder_id=client_id)
