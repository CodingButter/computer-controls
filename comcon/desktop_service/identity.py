"""Who is asking, decided by the service rather than claimed by the caller.

A client used to name itself in every request, and that name carried real weight:
it keyed grants, audit records and change attribution. A name a caller writes for
itself is a name a caller can write for somebody else, so a second agent on the
same socket could adopt the first one's identity, replace its grant, or have its
own actions recorded against it. Behind a single-user socket that was a noted
trade-off. With two agents it is a defect.

So identity is minted here, once per connection, and bound to the thread that
serves it. A client may lie about its name; it cannot lie about which connection
it is on. The name it sends survives as a label for a human reading the audit
log, with no authority behind it.
"""

from __future__ import annotations

import threading
import uuid

#: Bounds the label, which is the one field on an identity that a caller writes.
MAX_LABEL_LENGTH = 64

_local = threading.local()


def mint() -> str:
    """A fresh identity for a connection that has just been accepted."""
    return f"cl-{uuid.uuid4().hex[:8]}"


def label_of(value: object) -> str:
    """The caller's own name for itself, bounded and stripped of newlines.

    Bounded because it is written into an audit record, and a field a caller
    controls that ends up in a log is a field somebody will eventually put a
    megabyte of newlines into.
    """
    if not isinstance(value, str):
        return ""
    return value.replace("\n", " ").replace("\r", " ").strip()[:MAX_LABEL_LENGTH]


class bound:
    """Bind an identity for the life of a connection's serving thread.

    A context manager rather than a plain assignment so that the binding cannot
    outlive the connection: a thread that finishes serving one client and is
    reused would otherwise keep answering as that client.
    """

    def __init__(self, identity: str, label: str = "") -> None:
        self._identity = identity
        self._label = label
        self._previous: tuple[str, str] | None = None

    def __enter__(self) -> str:
        self._previous = (current(), current_label())
        _local.identity = self._identity
        _local.label = self._label
        return self._identity

    def __exit__(self, *_exc: object) -> None:
        identity, label = self._previous or ("", "")
        _local.identity = identity
        _local.label = label


def current() -> str:
    """The identity of the connection being served on this thread.

    Empty when there is no connection — an in-process caller, or a test driving
    the handlers directly. That emptiness is what makes the caller-supplied
    fallback safe: it is unreachable over a socket, because a socket always has
    a connection and therefore always has an issued identity.
    """
    return getattr(_local, "identity", "")


def current_label() -> str:
    return getattr(_local, "label", "")


def set_label(value: object) -> str:
    """Record what this connection calls itself. Returns the stored label."""
    _local.label = label_of(value)
    return _local.label
