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


class ApplicationNotFound(DesktopError):
    def __init__(self, application_id: str) -> None:
        super().__init__(
            ErrorCode.APPLICATION_NOT_FOUND,
            f"No application with id {application_id!r} is running",
            {"applicationId": application_id},
        )
