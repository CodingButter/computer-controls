"""The send gate: composing is not sending.

An attestation records what the service could see in a field at one moment, so
that a later commit can prove it has not changed underneath the caller. The
register lives in daemon memory only — never serialised, never written to disk,
bounded so a connection that attests a thousand fields does not grow the
process. The evidence is the field's own contents read by the service; the
caller writes the argument (which element), never the evidence (what text).

One attestation admits exactly one commit. A commit that fails verification —
the field changed between attest and commit — still spends the attestation,
because the caller must re-attest regardless: the field it was looking at is no
longer the field that is there.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

from .errors import DesktopError, ErrorCode


#: How long an attestation is good for. Short enough that a field typed into
#: and then left cannot be committed an hour later as though nothing moved;
#: long enough that a round trip through the model's reasoning fits.
ATTESTATION_TTL_SECONDS = 120.0

#: The register is bounded for the same reason every ledger in this service is:
#: a courtesy that grows without limit is a leak, and an attestation that will
#: never be redeemed costs the same memory as one that will.
_MAX_ATTESTATIONS = 256

_lock = threading.Lock()
_attestations: dict[str, _Attestation] = {}
_counter = 0


@dataclass
class _Attestation:
    attestation_id: str
    client_id: str
    element_id: str
    expected_text: str
    created_at: float
    expires_at: float
    #: The desktop's revision when the photograph was taken. The TTL says how
    #: long the caller may take to think; this says whether anything moved while
    #: it thought. Text equality alone cannot tell: a field that changed and
    #: changed back reads identical, and so does a change that leaves the text
    #: alone but not the thing around it.
    proof_revision: int = 0
    spent: bool = False


def attest(
    *, client_id: str, element_id: str, text: str, revision: int = 0
) -> tuple[str, int]:
    """Record what the service read. Returns (attestation_id, expires_in_ms).

    The text never leaves this register except through ``redeem``, and is
    never written to the audit log or any other persistent sink. It exists
    to be compared, and then it is gone.

    The revision is stamped alongside it, because an approval refers to the
    desktop as it was at one moment and the commit happens at another.
    """
    global _counter
    now = time.monotonic()
    with _lock:
        _sweep(now)
        _counter += 1
        attestation_id = f"att-{_counter:06d}"
        _attestations[attestation_id] = _Attestation(
            attestation_id=attestation_id,
            client_id=client_id,
            element_id=element_id,
            expected_text=text,
            created_at=now,
            expires_at=now + ATTESTATION_TTL_SECONDS,
            proof_revision=revision,
        )
        return attestation_id, int(ATTESTATION_TTL_SECONDS * 1000)


def redeem(*, client_id: str, attestation_id: str, element_id: str) -> tuple[str, int]:
    """Return the attested text and revision, and mark the attestation spent.

    Raises PERMISSION_DENIED if the attestation does not exist, has expired,
    was already spent, belongs to a different client, or names a different
    element. Every failure spends nothing except expiry, which removes the
    entry because an expired attestation is garbage, not a second chance.
    """
    now = time.monotonic()
    with _lock:
        _sweep(now)
        entry = _attestations.get(attestation_id)
        if entry is None:
            raise DesktopError(
                ErrorCode.PERMISSION_DENIED,
                f"No attestation {attestation_id!r} is recognised. "
                "Call attestElement first, or re-attest if it has expired.",
            )
        if entry.client_id != client_id:
            raise DesktopError(
                ErrorCode.PERMISSION_DENIED,
                f"Attestation {attestation_id!r} belongs to a different client.",
            )
        if entry.element_id != element_id:
            raise DesktopError(
                ErrorCode.PERMISSION_DENIED,
                f"Attestation {attestation_id!r} was taken for "
                f"{entry.element_id!r}, not {element_id!r}.",
            )
        if entry.spent:
            raise DesktopError(
                ErrorCode.PERMISSION_DENIED,
                f"Attestation {attestation_id!r} has already been used. "
                "One attestation admits one commit; re-attest to commit again.",
            )
        entry.spent = True
        return entry.expected_text, entry.proof_revision


def release_client(client_id: str) -> None:
    """Drop every attestation a disconnected client left behind.

    Called when a connection ends, for the same reason holds are released:
    an attestation owned by a process that no longer exists is an
    attestation that will never be redeemed, and holding it costs memory
    until the sweep notices.
    """
    with _lock:
        doomed = [
            aid for aid, att in _attestations.items() if att.client_id == client_id
        ]
        for aid in doomed:
            del _attestations[aid]


def _sweep(now: float) -> None:
    """Remove expired entries and evict the oldest if the register is full."""
    expired = [aid for aid, att in _attestations.items() if att.expires_at <= now]
    for aid in expired:
        del _attestations[aid]
    if len(_attestations) >= _MAX_ATTESTATIONS:
        oldest = min(_attestations, key=lambda aid: _attestations[aid].expires_at)
        del _attestations[oldest]
