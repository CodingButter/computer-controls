"""One line per call, including the calls that were refused.

A log of what an agent did is half a log. The refusals are the half worth
keeping: an agent that tried to close a window and was told no is a fact about
the agent, and it is invisible in a record that only lists what succeeded.
Every decision lands here, allowed or not, with the reason attached.

The file is append-only by discipline and by open mode. Nothing in this service
reads it back except the tail method, nothing rewrites it, and nothing prunes
it while the service is running — a log that edits itself is a log with a story
to tell about the one line that is missing.

The records are JSON, one per line, because the format has to survive being
read by something that is not this program: `tail -f` during a demo, `jq` after
an incident, a client that wants to show the user what happened this morning.

What is not in a record: any element value, any window title, any typed text.
The audit log is a fourth sink for exactly the values the redaction module
exists to withhold, and it is the easiest one to forget, because it feels like
somewhere secrets are safe. It is on somebody's disk. Records carry what was
done, to which application, and how it went — never the contents.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO

#: The record version. Anything reading these later has to be able to tell what
#: shape it is looking at without guessing from the keys present.
RECORD_VERSION = 1


def default_path() -> Path:
    """Where the log lives, following the same convention as the socket.

    State, not cache and not config: it is not disposable and the user did not
    write it.
    """
    state = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return Path(state) / "mastracode-desktop" / "audit.jsonl"


@dataclass
class Record:
    """One call, as it will be read back months later by someone annoyed."""

    method: str
    operation_class: str
    client_id: str
    decision: str
    reason: str = ""
    application: str = ""
    window_id: str = ""
    element_id: str = ""
    backend: str = ""
    fallbacks: tuple[str, ...] = ()
    duration_ms: int = 0
    from_revision: int = 0
    to_revision: int = 0
    error_code: str = ""
    detail: dict[str, Any] = field(default_factory=dict)

    def to_json(self, *, at: float) -> str:
        payload: dict[str, Any] = {
            "v": RECORD_VERSION,
            "at": _timestamp(at),
            "method": self.method,
            "operationClass": self.operation_class,
            "clientId": self.client_id,
            "decision": self.decision,
        }
        if self.reason:
            payload["reason"] = self.reason
        for key, value in (
            ("application", self.application),
            ("windowId", self.window_id),
            ("elementId", self.element_id),
            ("backend", self.backend),
            ("errorCode", self.error_code),
        ):
            if value:
                payload[key] = value
        if self.fallbacks:
            payload["fallbacksUsed"] = list(self.fallbacks)
        if self.duration_ms:
            payload["durationMs"] = self.duration_ms
        if self.to_revision or self.from_revision:
            payload["revisions"] = [self.from_revision, self.to_revision]
        if self.detail:
            payload["detail"] = self.detail
        return json.dumps(payload, ensure_ascii=False, sort_keys=False)


def _timestamp(at: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(at)) + f".{int((at % 1) * 1000):03d}Z"


class AuditLog:
    """The open file, and the promise that a failure to write is not silent.

    A logging call that raises would turn a working desktop action into an
    error, which is the wrong trade: the action really happened. A logging call
    that swallows everything turns a full disk into a service that quietly
    stops recording, which is worse. So a write failure is counted and reported
    through `health`, and the caller's action proceeds.
    """

    def __init__(self, path: Path | None = None, *, now=time.time, enabled: bool = True) -> None:
        self._path = Path(path) if path else default_path()
        self._now = now
        self._enabled = enabled
        self._handle: TextIO | None = None
        self._written = 0
        self._failures = 0
        self._last_error = ""

    @property
    def path(self) -> Path:
        return self._path

    def _open(self) -> TextIO | None:
        if self._handle is not None:
            return self._handle
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # 0600: the log names which applications an agent touched and when
        # somebody was at the machine. That is not for other users on this box.
        fd = os.open(self._path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        self._handle = os.fdopen(fd, "a", encoding="utf-8")
        return self._handle

    def write(self, record: Record) -> None:
        if not self._enabled:
            return
        try:
            handle = self._open()
            if handle is None:
                return
            handle.write(record.to_json(at=self._now()) + "\n")
            handle.flush()
            self._written += 1
        except OSError as error:
            # Losing the log must not lose the action. It must, however, be
            # visible: silence here looks exactly like a quiet desktop.
            self._failures += 1
            self._last_error = str(error)
            self._handle = None

    def tail(self, limit: int = 20) -> list[dict[str, Any]]:
        """The last `limit` records, oldest first.

        Reads the file rather than an in-memory ring, so a client sees the same
        history a human tailing the file would — including the records written
        by whoever else is attached to this service.
        """
        if not self._path.exists():
            return []
        lines = self._path.read_text(encoding="utf-8", errors="replace").splitlines()
        records: list[dict[str, Any]] = []
        for line in lines[-max(0, limit):]:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                # A truncated final line is what a crash mid-write looks like.
                # Skipping it is right; hiding that it was there is not.
                records.append({"v": RECORD_VERSION, "unreadable": True})
        return records

    def health(self) -> dict[str, Any]:
        return {
            "path": str(self._path),
            "written": self._written,
            "writeFailures": self._failures,
            "lastError": self._last_error,
            "enabled": self._enabled,
        }

    def close(self) -> None:
        if self._handle is not None:
            self._handle.close()
            self._handle = None
