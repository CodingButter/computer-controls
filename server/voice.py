"""Voice client: thin httpx proxy to the existing voice-api.

Q1's recommended path: the server proxies STT/TTS to the already-running
voice-api on bigbeast (FastAPI at ~/voice, endpoints /api/transcribe and
/api/synthesize). If the human later chooses *embed* instead of *proxy*,
this module is the only swap point — the Agent and server are unchanged.

The client is async (httpx.AsyncClient) to run inside the FastAPI event loop
without blocking. A missing voice-api (R-VOICE-DEP) degrades gracefully: the
caller gets a VoiceError, not a crash.
"""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger(__name__)

DEFAULT_VOICE_ID = "Wren"
DEFAULT_TIMEOUT_S = 30.0


class VoiceError(Exception):
    """An error from the voice-api proxy."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class VoiceClient:
    """Proxy to the existing voice-api for STT and TTS."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout_s = timeout_s
        self._client: httpx.AsyncClient | None = None

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=self._timeout_s)
        return self._client

    async def transcribe(self, audio_bytes: bytes) -> str:
        """Send audio to /api/transcribe, return the transcribed text."""
        client = await self._ensure_client()
        try:
            resp = await client.post(
                f"{self._base_url}/api/transcribe",
                content=audio_bytes,
                headers={"Content-Type": "application/octet-stream"},
            )
        except httpx.HTTPError as exc:
            raise VoiceError(
                f"Could not reach the voice-api for transcription: {exc}"
            ) from exc

        if resp.status_code != 200:
            raise VoiceError(
                f"Voice-api transcribe returned {resp.status_code}",
                status=resp.status_code,
            )
        return resp.json().get("text", "")

    async def synthesize(
        self, text: str, *, voice_id: str = DEFAULT_VOICE_ID
    ) -> bytes:
        """Send text to /api/synthesize, return audio bytes."""
        client = await self._ensure_client()
        try:
            resp = await client.post(
                f"{self._base_url}/api/synthesize",
                json={"text": text, "voice": voice_id},
            )
        except httpx.HTTPError as exc:
            raise VoiceError(
                f"Could not reach the voice-api for synthesis: {exc}"
            ) from exc

        if resp.status_code != 200:
            raise VoiceError(
                f"Voice-api synthesize returned {resp.status_code}",
                status=resp.status_code,
            )
        return resp.content

    async def close(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
