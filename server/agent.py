"""Agent interface + stub implementation (Fork 8 — the biggest scope guardrail).

The ``Agent`` protocol defines a single async turn: given transcribed text (or
raw audio bytes), produce a reply. The ``StubAgent`` reflects the current
desktop state or echoes a fixed response — it proves the voice path end-to-end
without requiring an LLM. A real agent plugs in later by implementing the same
protocol, with no changes to the server or PWA.

No agent/LLM/conversation infrastructure exists in the repo (confirmed during
triage). This is the scope boundary: milestone 1 ships the stub.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class Agent(Protocol):
    """A single conversational turn: input text → reply text."""

    async def turn(
        self, text: str, *, desktop_state: dict[str, Any] | None = None
    ) -> str:
        ...


class StubAgent:
    """Reflects the current desktop state in a fixed reply.

    This is NOT an LLM — it proves the voice path works end-to-end. The reply
    names the focused window (if any) so a tester can see the relay is live.
    """

    def __init__(self, *, fallback: str = "I heard you.") -> None:
        self._fallback = fallback

    async def turn(
        self, text: str, *, desktop_state: dict[str, Any] | None = None
    ) -> str:
        if not text.strip():
            return self._fallback

        if desktop_state:
            windows = desktop_state.get("windows", [])
            active_id = desktop_state.get("activeWindowId", "")
            active = next(
                (w for w in windows if w.get("windowId") == active_id),
                None,
            )
            if active:
                title = active.get("title", "untitled")
                return f"You said: {text.strip()}. The focused window is {title}."
            if windows:
                return f"You said: {text.strip()}. I can see {len(windows)} window(s)."

        return f"You said: {text.strip()}."
