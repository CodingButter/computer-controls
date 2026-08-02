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

from . import errors, identity, protocol_generated

#: The methods that write into an element, derived from the operation class the
#: protocol already assigns them rather than listed here. A list would be a
#: second place to remember, and the method that got forgotten in it would be
#: the one that quietly went unowned.
WRITE_METHODS = frozenset(
    method
    for method, operation_class in protocol_generated.OPERATION_CLASS.items()
    if operation_class == "edit"
)


@dataclass(frozen=True)
class Hold:
    """One writer's ownership of one element."""

    element_id: str
    client_id: str
    client_label: str
    method: str
    since: float

    def held_for_ms(self) -> int:
        return int((time.monotonic() - self.since) * 1000)


_holds: dict[str, Hold] = {}
#: Guards `_holds` only. It is never held across a call onto the GLib loop, so
#: it cannot take part in a deadlock with the thread that owns the toolkit.
_lock = threading.Lock()


def holder(element_id: str) -> Hold | None:
    """Who owns this element right now, if anyone."""
    with _lock:
        return _holds.get(element_id)


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
        existing = _holds.get(element_id)
        if existing is None:
            _holds[element_id] = hold
            return hold
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
    hold = acquire(element_id, client_id, method)
    try:
        yield hold
    finally:
        release(element_id, holder_id=client_id)
