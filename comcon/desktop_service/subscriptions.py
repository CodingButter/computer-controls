"""Which elements a connection has asked to be told about.

This is the observation counterpart to holds: a claim takes write ownership of an
element for the duration of a piece of work; a subscription takes observation
interest in an element for the duration of a connection. Neither is a promise
made by the other — a subscribed element can still be claimed and written by
anyone, because watching is not touching.

Keyed by the transport-minted identity for the same reason attention is: it is
the only name a client cannot write for itself, so a subscription left behind by
a gone connection cannot be inherited or confused with a live one. Identities
are never reused, so a survivor is leak cleanup, not a security question.

The union of every connection's subscriptions is the declared watch set — the
elements sampled on every observation sweep regardless of recency, because a
declared intent outranks the heuristic that ranks by how recently something was
touched. A service that accepted a thousand subscriptions and quietly sampled the
first sixteen would have reinvented the bug this module exists to fix.
"""

from __future__ import annotations

import threading

from .errors import DesktopError, ErrorCode

#: A connection may watch this many elements at once. Observation cost is the
#: global union across connections, so a modest per-connection bound keeps
#: sampling cost low while giving a connection enough room for a form's worth of
#: fields.
MAX_SUBSCRIPTIONS_PER_CONNECTION = 32

_lock = threading.Lock()
_subscribed: dict[str, set[str]] = {}


def declare(client_id: str, element_id: str) -> None:
    """Record that this connection wants to be told about this element.

    Idempotent — subscribing to an element already subscribed to is not an
    error and does not count twice against the ceiling. A subscription over an
    id naming nothing is refused before it reaches here, so the caller is never
    given an unkeepable promise.
    """
    if not client_id:
        return
    with _lock:
        current = _subscribed.get(client_id, set())
        if element_id in current:
            return
        if len(current) >= MAX_SUBSCRIPTIONS_PER_CONNECTION:
            raise DesktopError(
                ErrorCode.SUBSCRIPTION_LIMIT_REACHED,
                f"Connection {client_id!r} already holds the maximum of "
                f"{MAX_SUBSCRIPTIONS_PER_CONNECTION} element subscriptions",
                {"ceiling": MAX_SUBSCRIPTIONS_PER_CONNECTION},
            )
        current.add(element_id)
        _subscribed[client_id] = current


def has(client_id: str, element_id: str) -> bool:
    if not client_id:
        return False
    with _lock:
        return element_id in _subscribed.get(client_id, ())


def release(client_id: str, element_id: str) -> bool:
    """Drop one element from this connection's subscriptions.

    Returns whether there was anything to release, so a caller releasing what it
    never subscribed to is told — not refused, but told the truth: nothing was
    given up because there was nothing to give up.
    """
    if not client_id:
        return False
    with _lock:
        current = _subscribed.get(client_id)
        if current is None or element_id not in current:
            return False
        current.discard(element_id)
        if not current:
            _subscribed.pop(client_id, None)
        return True


def forget(client_id: str) -> None:
    """Drop a connection's subscriptions when the connection goes.

    Identities are minted per connection and never reused, so subscriptions left
    behind are not a security problem — they are a leak, one entry per
    connection for the life of the process, which is the kind of thing a
    long-lived daemon notices eventually.
    """
    if not client_id:
        return
    with _lock:
        _subscribed.pop(client_id, None)


def all_ids() -> set[str]:
    """The union of every connection's subscribed element ids.

    This is the declared watch set — the elements sampled on every sweep
    regardless of recency. It folds into ``_observe`` alongside the recency
    heuristic's top-N, so a subscribed element is seen even when it has not been
    touched in a hundred revisions.
    """
    with _lock:
        result: set[str] = set()
        for ids in _subscribed.values():
            result |= ids
        return result


def purge(element_id: str) -> None:
    """Remove a gone element from every connection's subscriptions.

    Called when an element has been observed to go stale, so no connection is
    left holding a subscription to something that can no longer be reported on.
    """
    with _lock:
        for ids in _subscribed.values():
            ids.discard(element_id)
        empty = [cid for cid, ids in _subscribed.items() if not ids]
        for cid in empty:
            _subscribed.pop(cid, None)


def clear() -> None:
    with _lock:
        _subscribed.clear()
