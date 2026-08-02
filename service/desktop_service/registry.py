"""Stable element references, revisions, and staleness detection.

The rule this module exists to enforce: an id never resolves to a different
element than the one the caller was shown. Desktops mutate under you — a list
repopulates, a dialog closes and a similar one opens, a button is relabelled.
Acting on "the element that looks about right" is how an agent clicks Delete
when it meant Save.

So every registered element carries a **fingerprint** of what the caller was
told, and resolving verifies it. A mismatch is an error with enough detail to
re-resolve, never a substitution.

This module holds no toolkit binding. It reaches the desktop through two
callables supplied by the caller, which keeps `gi` inside `backends/`.
"""

from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass
from typing import Any, Callable

from .errors import DesktopError, ErrorCode


@dataclass(frozen=True)
class Fingerprint:
    """What an element looked like when the caller last saw it.

    Position among siblings is included because role and name alone do not
    distinguish the third "Delete" button in a list from the first, and the
    parent's digest is included so an identical-looking element in a different
    container is a different fingerprint.
    """

    role: str
    name: str
    index: int
    parent: str = ""

    def digest(self) -> str:
        raw = "\0".join((self.role, self.name, str(self.index), self.parent))
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]

    def differences(self, other: "Fingerprint") -> dict[str, list[str]]:
        """Field-by-field diff, for the stale error's `changed` detail.

        The caller gets told what moved, not merely that something did.
        """
        changed: dict[str, list[str]] = {}
        if self.role != other.role:
            changed["role"] = [self.role, other.role]
        if self.name != other.name:
            changed["name"] = [self.name, other.name]
        if self.index != other.index:
            changed["index"] = [str(self.index), str(other.index)]
        if self.parent != other.parent:
            changed["parent"] = [self.parent, other.parent]
        return changed


@dataclass
class RegistryEntry:
    """What the registry remembers about an element it handed out."""

    element_id: str
    backend: str
    backend_reference: dict[str, Any]
    fingerprint: Fingerprint
    # The revision at which this fingerprint was last shown to a caller. Not the
    # revision it was first seen at: re-observing an element updates both the
    # fingerprint and this stamp, because the caller has now been told the new
    # truth and a reference minted from that observation is not stale.
    observed_at: int


class ElementReferenceStale(DesktopError):
    def __init__(
        self,
        element_id: str,
        observed_at: int,
        current_revision: int,
        changed: dict[str, list[str]],
        new_id: str | None = None,
    ) -> None:
        detail: dict[str, Any] = {
            "elementId": element_id,
            "observedAtRevision": observed_at,
            "currentRevision": current_revision,
            "changed": changed,
        }
        if new_id is not None:
            detail["newElementId"] = new_id
        summary = (
            "the element it referred to no longer exists"
            if not changed
            else "it changed: " + ", ".join(sorted(changed))
        )
        super().__init__(
            ErrorCode.ELEMENT_REFERENCE_STALE,
            f"Element reference {element_id!r} is stale — {summary}",
            detail,
        )


class ElementNotFound(DesktopError):
    def __init__(self, element_id: str) -> None:
        super().__init__(
            ErrorCode.ELEMENT_NOT_FOUND,
            f"No element is registered under id {element_id!r}",
            {"elementId": element_id},
        )


# Asks the desktop what an object looks like *right now*. Returns None when the
# object is gone. Supplied by the caller so this module imports no toolkit.
Prober = Callable[[dict[str, Any]], Fingerprint | None]

# Looks for an element matching a fingerprint that no longer resolves, so a
# stale error can carry the replacement. Returns (new_id, reference, current
# fingerprint) or None.
Rediscoverer = Callable[
    [Fingerprint, dict[str, Any]], tuple[str, dict[str, Any], Fingerprint] | None
]


class ElementRegistry:
    """Session-scoped element identity and revision state.

    The revision counter is monotonic and increments **once per observation that
    changed something** — not once per element. A single inspection of fifty
    elements advances it by one if anything moved, and by nothing if the window
    is exactly as it was. That is what makes a revision range a meaningful unit
    for the delta and causal-attribution work built on top of it.
    """

    def __init__(
        self, prober: Prober | None = None, rediscoverer: Rediscoverer | None = None
    ) -> None:
        self._entries: dict[str, RegistryEntry] = {}
        self._revision = 0
        self._lock = threading.RLock()
        self._prober = prober
        self._rediscoverer = rediscoverer

    @property
    def revision(self) -> int:
        with self._lock:
            return self._revision

    def bump(self) -> int:
        """Advance the revision. The delta engine drives this from desktop events."""
        with self._lock:
            self._revision += 1
            return self._revision

    def record(
        self,
        observations: list[tuple[str, str, dict[str, Any], Fingerprint]],
    ) -> int:
        """Register a batch of observed elements; return the revision they hold at.

        Each observation is (element_id, backend, backend_reference, fingerprint).
        Ids are minted by the backend from the object's stable address, so
        observing the same element twice yields the same id — that is what makes
        references survive across calls without a lookup table.
        """
        with self._lock:
            changed = False
            for element_id, backend, reference, fingerprint in observations:
                existing = self._entries.get(element_id)
                if existing is not None and existing.fingerprint == fingerprint:
                    continue
                changed = True
                self._entries[element_id] = RegistryEntry(
                    element_id=element_id,
                    backend=backend,
                    backend_reference=reference,
                    fingerprint=fingerprint,
                    observed_at=self._revision + 1,
                )
            if changed:
                self._revision += 1
            else:
                return self._revision
            # Entries recorded above were stamped with the new revision.
            return self._revision

    def recent(self, limit: int, roles: frozenset[str] | None = None) -> list[str]:
        """The ids most recently shown to a caller, newest first.

        For observers that must re-read something on every look and therefore
        cannot re-read everything. Recency is the right cut because a reference
        nobody has touched in a hundred revisions is one nobody is waiting on,
        and the bound belongs here rather than at the call site: a session that
        has inspected ten thousand elements must not make each observation ten
        thousand round trips slower than the last.
        """
        with self._lock:
            entries = list(self._entries.values())
        if roles is not None:
            entries = [e for e in entries if e.fingerprint.role in roles]
        entries.sort(key=lambda entry: entry.observed_at, reverse=True)
        return [entry.element_id for entry in entries[:limit]]

    def get(self, element_id: str) -> RegistryEntry:
        """The stored entry, without touching the desktop. Never verifies."""
        with self._lock:
            entry = self._entries.get(element_id)
        if entry is None:
            raise ElementNotFound(element_id)
        return entry

    def resolve(self, element_id: str) -> RegistryEntry:
        """Return the entry only if the desktop still agrees with what we told the caller.

        This is the method that refuses to guess. If the object is gone, or is no
        longer the thing described by the stored fingerprint, it raises rather
        than returning something plausible — and when the same element can be
        found again, the error carries its new id so the caller can re-acquire in
        one step instead of re-inspecting the whole window.
        """
        entry = self.get(element_id)
        if self._prober is None:
            return entry

        current = self._prober(entry.backend_reference)
        if current == entry.fingerprint:
            return entry

        changed = (
            entry.fingerprint.differences(current) if current is not None else {}
        )
        new_id = self._rediscover(entry)
        raise ElementReferenceStale(
            element_id=element_id,
            observed_at=entry.observed_at,
            current_revision=self.revision,
            changed=changed,
            new_id=new_id,
        )

    def _rediscover(self, entry: RegistryEntry) -> str | None:
        if self._rediscoverer is None:
            return None
        try:
            found = self._rediscoverer(entry.fingerprint, entry.backend_reference)
        except Exception:  # noqa: BLE001 - a failed re-resolution is not an error
            return None
        if found is None:
            return None
        new_id, reference, fingerprint = found
        if new_id == entry.element_id:
            # The same id cannot be both stale and the answer to its own
            # staleness. Reporting it would send the caller into a loop.
            return None
        self.record([(new_id, entry.backend, reference, fingerprint)])
        return new_id
