"""Error vocabulary shared by every method in the service.

Every error that crosses the socket carries three things: a stable machine code
from `ErrorCode`, a human-readable message, and structured detail the caller can
act on. Callers branch on the code; the message is for the transcript.
"""

from __future__ import annotations

from typing import Any

# JSON-RPC 2.0 reserved codes. Ours live in `data.code`, so the JSON-RPC layer
# stays standard and the domain vocabulary stays ours.
JSONRPC_PARSE_ERROR = -32700
JSONRPC_INVALID_REQUEST = -32600
JSONRPC_METHOD_NOT_FOUND = -32601
JSONRPC_INVALID_PARAMS = -32602
JSONRPC_INTERNAL_ERROR = -32603


class ErrorCode:
    APPLICATION_NOT_FOUND = "APPLICATION_NOT_FOUND"
    WINDOW_NOT_FOUND = "WINDOW_NOT_FOUND"
    ELEMENT_NOT_FOUND = "ELEMENT_NOT_FOUND"
    ELEMENT_REFERENCE_STALE = "ELEMENT_REFERENCE_STALE"
    BACKEND_UNAVAILABLE = "BACKEND_UNAVAILABLE"
    ACTION_NOT_SUPPORTED = "ACTION_NOT_SUPPORTED"
    PERMISSION_DENIED = "PERMISSION_DENIED"
    #: Separate from PERMISSION_DENIED on purpose. "You may not do this" and
    #: "you may, but ask again" call for different behaviour from a caller: one
    #: is a wall and the other is a door that closed on a timer.
    SESSION_EXPIRED = "SESSION_EXPIRED"
    #: Refused because somebody else is already writing this element. Not a
    #: permission answer: the caller may write here, just not while the text of
    #: another writer is still going in.
    ELEMENT_HELD = "ELEMENT_HELD"
    #: The caller's own claim ran out before it finished the work it took the
    #: claim for. Nothing is in the way — the element is free — so this is a
    #: report about an estimate rather than a refusal about a conflict.
    CLAIM_EXPIRED = "CLAIM_EXPIRED"
    TIMEOUT = "TIMEOUT"
    METHOD_NOT_FOUND = "METHOD_NOT_FOUND"
    INVALID_PARAMS = "INVALID_PARAMS"
    INTERNAL_ERROR = "INTERNAL_ERROR"


ALL_CODES = frozenset(
    value
    for name, value in vars(ErrorCode).items()
    if not name.startswith("_") and isinstance(value, str)
)


class DesktopError(Exception):
    """An error with a code the caller can branch on."""

    def __init__(
        self,
        code: str,
        message: str,
        detail: dict[str, Any] | None = None,
        jsonrpc_code: int = JSONRPC_INTERNAL_ERROR,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail or {}
        self.jsonrpc_code = jsonrpc_code

    def to_jsonrpc_error(self) -> dict[str, Any]:
        return {
            "code": self.jsonrpc_code,
            "message": self.message,
            "data": {"code": self.code, "detail": self.detail},
        }


class MethodNotFound(DesktopError):
    def __init__(self, method: str) -> None:
        super().__init__(
            ErrorCode.METHOD_NOT_FOUND,
            f"Unknown method: {method}",
            {"method": method},
            JSONRPC_METHOD_NOT_FOUND,
        )


class InvalidParams(DesktopError):
    def __init__(self, message: str, detail: dict[str, Any] | None = None) -> None:
        super().__init__(
            ErrorCode.INVALID_PARAMS, message, detail, JSONRPC_INVALID_PARAMS
        )


class InternalError(DesktopError):
    def __init__(self, message: str, detail: dict[str, Any] | None = None) -> None:
        super().__init__(ErrorCode.INTERNAL_ERROR, message, detail)


class BackendUnavailable(DesktopError):
    def __init__(self, backend: str, reason: str) -> None:
        super().__init__(
            ErrorCode.BACKEND_UNAVAILABLE,
            f"Backend {backend!r} is unavailable: {reason}",
            {"backend": backend, "reason": reason},
        )


class TimeoutError_(DesktopError):
    def __init__(self, what: str, seconds: float) -> None:
        super().__init__(
            ErrorCode.TIMEOUT,
            f"{what} did not complete within {seconds}s",
            {"operation": what, "timeoutSeconds": seconds},
        )


class PermissionDenied(DesktopError):
    """Refused, with the reason and the way to change the answer.

    A denial that only says no leaves the caller to guess between "never
    allowed", "not allowed yet" and "not allowed here", and a model that has to
    guess will try all three. The detail names which operation class was
    required and what the session actually holds, so a client can either ask
    for the grant it is missing or stop asking.
    """

    def __init__(
        self,
        message: str,
        *,
        method: str = "",
        required: str = "",
        granted: tuple[str, ...] | list[str] = (),
        application: str = "",
        remedy: str = "",
    ) -> None:
        detail: dict[str, Any] = {}
        if method:
            detail["method"] = method
        if required:
            detail["requiredOperationClass"] = required
        if granted:
            detail["grantedOperationClasses"] = list(granted)
        if application:
            detail["application"] = application
        if remedy:
            detail["remedy"] = remedy
        super().__init__(ErrorCode.PERMISSION_DENIED, message, detail)


class SessionExpired(DesktopError):
    def __init__(self, message: str, *, idle_seconds: float = 0.0, remedy: str = "") -> None:
        detail: dict[str, Any] = {}
        if idle_seconds:
            detail["idleSeconds"] = round(idle_seconds, 1)
        if remedy:
            detail["remedy"] = remedy
        super().__init__(ErrorCode.SESSION_EXPIRED, message, detail)


class ElementHeld(DesktopError):
    """Refused because another writer owns this element right now.

    Named rather than anonymous because the two things a caller can do about it
    differ entirely: a field held by another agent is worth coming back to, and
    a field held by the caller's own other worker is a bug in the caller. Both
    answers are in `heldBy`, so neither has to be guessed at.

    The holder's own name for itself travels beside its issued identity for the
    same reason it does in the audit log — `cl-3f2a91b8` is unambiguous and
    tells a human nothing.
    """

    def __init__(
        self,
        element_id: str,
        *,
        held_by: str = "",
        held_by_label: str = "",
        held_method: str = "",
        held_for_ms: int = 0,
    ) -> None:
        who = held_by_label or held_by or "another caller"
        doing = f" ({held_method})" if held_method else ""
        detail: dict[str, Any] = {
            "elementId": element_id,
            "heldBy": held_by,
            "heldMethod": held_method,
            "heldForMs": held_for_ms,
            "remedy": (
                "wait for the holder to finish and write again, or write to a "
                "different element — this element is not queued"
            ),
        }
        if held_by_label:
            detail["heldByLabel"] = held_by_label
        super().__init__(
            ErrorCode.ELEMENT_HELD,
            f"Element {element_id!r} is being written by {who}{doing}",
            detail,
        )


class ClaimExpired(DesktopError):
    """The claim this write was meant to happen under ran out before it arrived.

    Distinct from ELEMENT_HELD because nothing is in the way: the element is
    free, and the caller could take it again this second. What it must not do is
    carry on believing the lease it asked for covered the work it is doing.
    Reported once, to the client whose claim lapsed, and then forgotten — a
    stream of errors about a lease that ended a minute ago tells nobody
    anything.
    """

    def __init__(self, element_id: str, *, lease_ms: int = 0) -> None:
        detail: dict[str, Any] = {
            "elementId": element_id,
            "leaseMs": lease_ms,
            "remedy": (
                "claim the element again with an estimate that covers the work, "
                "then read the field before writing — it may not say what it "
                "said when the claim was taken"
            ),
        }
        super().__init__(
            ErrorCode.CLAIM_EXPIRED,
            f"The claim on {element_id!r} expired before this write",
            detail,
        )


class ApplicationNotFound(DesktopError):
    def __init__(self, application_id: str) -> None:
        super().__init__(
            ErrorCode.APPLICATION_NOT_FOUND,
            f"No application with id {application_id!r} is running",
            {"applicationId": application_id},
        )
