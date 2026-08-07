"""What a connection is looking at, as opposed to what it is allowed to touch.

Permission and attention are different questions that share a vocabulary, and
keeping them apart is most of this module. The consent ceiling says what may be
reached at all and is set by the user; attention says what one client wants to
be shown out of that, and is set by the client. So attention can only ever
subtract. A connection that names an application it is walled off from names
nothing: the ceiling has already removed that row before attention is consulted,
and there is no order of operations here in which asking for a blocked
application confirms it is running.

Attention is per connection, keyed by the identity the transport mints, because
that is the only name a client cannot write for itself. One connection is one
attention: an orchestrator watching the whole desktop and a worker living inside
one application are two connections, which is the shape the multi-agent segment
is heading for anyway.

An undeclared connection attends to the whole desktop at the shallow depth
budget, so every client that existed before this module carries on unchanged.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

#: Look at the top of what you are watching, or all the way down it. The deep
#: budget is only affordable once applications are named — the tree under one
#: application is small in a way the tree under the desktop is not — so `tree`
#: without a scope is a declaration of intent that buys nothing yet.
SURFACE = "surface"
TREE = "tree"


@dataclass(frozen=True)
class Attention:
    """One connection's answer to "which applications, and how deep"."""

    #: Normalised for matching: stripped and casefolded, the same way the
    #: ceiling normalises its own lists, so the two agree about what a name is.
    applications: frozenset[str] = frozenset()
    depth: str = SURFACE
    #: What the client actually said, kept only to echo back. Reporting the
    #: casefolded set would tell a caller its own request had been rewritten.
    declared: tuple[str, ...] = field(default=())

    @property
    def scoped(self) -> bool:
        return bool(self.applications)

    def covers(self, *identifiers: str) -> bool:
        """Is this row one of the things the client asked to see?

        Identifiers are the ways a row names its application — an id and a
        display name, usually — and matching any of them is enough. A row that
        names no application at all is covered only when attention is unset: to
        an agent living inside one application, something happening nowhere in
        particular is exactly the news it asked not to be woken for.
        """
        if not self.scoped:
            return True
        for identifier in identifiers:
            name = str(identifier or "").strip().casefold()
            if not name:
                continue
            if any(wanted in name for wanted in self.applications):
                return True
        return False

    def depth_ceiling(self, surface: int, tree: int) -> int:
        """The deepest walk this connection may ask for.

        The flat ceiling exists because a walk from the desktop is unbounded in
        practice, not because twelve levels is a meaningful number. Where a walk
        starts inside a named application the node budget — which is the real
        cost bound — still applies, so the depth cap can be relaxed without
        relaxing what it was protecting.

        This answers for the connection. Whether a *particular* walk starts
        inside one of those applications is a question about a target, which
        this module cannot see and does not guess at: the caller confirms it
        with `covers` before spending the deeper budget. Attention subtracts,
        so a declaration on its own is never enough to be granted more.
        """
        return tree if self.scoped and self.depth == TREE else surface


#: What a connection gets before it says anything: everything, shallowly.
UNSET = Attention()

_lock = threading.Lock()
_declared: dict[str, Attention] = {}


def declare(client_id: str, applications=(), depth: str = SURFACE) -> Attention:
    named = tuple(str(name).strip() for name in applications or () if str(name).strip())
    attention = Attention(
        applications=frozenset(name.casefold() for name in named),
        depth=depth if depth in (SURFACE, TREE) else SURFACE,
        declared=named,
    )
    if not client_id:
        return attention
    with _lock:
        _declared[client_id] = attention
    return attention


def of(client_id: str) -> Attention:
    if not client_id:
        return UNSET
    with _lock:
        return _declared.get(client_id, UNSET)


def forget(client_id: str) -> None:
    """Drop a connection's attention when the connection goes.

    Identities are minted per connection and never reused, so an attention left
    behind is not a security problem — it is a leak, one entry per connection
    for the life of the process, which is the kind of thing a long-lived daemon
    notices eventually.
    """
    if not client_id:
        return
    with _lock:
        _declared.pop(client_id, None)


def clear() -> None:
    with _lock:
        _declared.clear()
