"""Tests for the voice path: POST /turn (mock VoiceClient + StubAgent).

No real voice-api required (--no-live safe). The StubAgent proves the
end-to-end path: audio → STT → agent turn → TTS → audio reply.
"""

from __future__ import annotations

from io import BytesIO
from typing import Any

import pytest
from fastapi.testclient import TestClient

from server.agent import StubAgent
from server.app import create_app
from server.auth import mint_token
from server.config import ServerConfig
from server.voice import VoiceError

SECRET = "voice-test-secret"

# Reusable fake audio bytes for upload.
FAKE_AUDIO = b"fake-webm-opus-audio-data"


@pytest.fixture
def voice_client():
    """A mock VoiceClient that records calls and returns canned responses."""

    class MockVoiceClient:
        def __init__(self) -> None:
            self.transcribe_calls: list[bytes] = []
            self.synthesize_calls: list[tuple[str, str]] = []

        async def transcribe(self, audio_bytes: bytes) -> str:
            self.transcribe_calls.append(audio_bytes)
            return "hello computer"

        async def synthesize(self, text: str, *, voice_id: str = "Wren") -> bytes:
            self.synthesize_calls.append((text, voice_id))
            return b"fake-mp3-audio-reply"

        async def close(self) -> None:
            pass

    return MockVoiceClient()


@pytest.fixture
def app_with_voice(voice_client):
    cfg = ServerConfig(
        shared_secret=SECRET,
        daemon_socket_path="/nonexistent.sock",
        voice_api_url="http://fake-voice-api",
    )
    app = create_app(cfg)
    app.state.voice = voice_client
    app.state.agent = StubAgent()
    return app


@pytest.fixture
def client(app_with_voice):
    return TestClient(app_with_voice)


@pytest.fixture
def token() -> str:
    return mint_token(SECRET, ttl_s=3600)


# --- POST /turn --------------------------------------------------------------

class TestTurn:
    def test_returns_audio_reply(self, client: TestClient, token: str) -> None:
        resp = client.post(
            "/turn",
            files={"audio": ("audio.webm", BytesIO(FAKE_AUDIO), "audio/webm")},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "audio/mpeg"
        assert resp.content == b"fake-mp3-audio-reply"
        # The transcript and reply are surfaced in headers for debugging.
        assert resp.headers["X-Transcript"] == "hello computer"
        assert "You said" in resp.headers["X-Reply"]

    def test_rejects_unauthenticated(self, client: TestClient) -> None:
        resp = client.post(
            "/turn",
            files={"audio": ("audio.webm", BytesIO(FAKE_AUDIO), "audio/webm")},
        )
        assert resp.status_code == 401

    def test_rejects_bad_token(self, client: TestClient) -> None:
        resp = client.post(
            "/turn",
            files={"audio": ("audio.webm", BytesIO(FAKE_AUDIO), "audio/webm")},
            headers={"Authorization": "Bearer bogus"},
        )
        assert resp.status_code == 401


class TestTurnNoVoiceConfigured:
    def test_returns_503(self) -> None:
        cfg = ServerConfig(
            shared_secret=SECRET,
            daemon_socket_path="/nonexistent.sock",
            voice_api_url="",  # no voice-api configured
        )
        app = create_app(cfg)
        c = TestClient(app)
        token = mint_token(SECRET, ttl_s=3600)
        resp = c.post(
            "/turn",
            files={"audio": ("audio.webm", BytesIO(FAKE_AUDIO), "audio/webm")},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 503
        assert "voice-api not configured" in resp.json()["error"]


class TestTurnVoiceError:
    def test_returns_502_on_transcribe_failure(
        self, app_with_voice, token: str
    ) -> None:
        # Swap the voice client for one that fails.
        class FailingVoice:
            async def transcribe(self, audio_bytes: bytes) -> str:
                raise VoiceError("voice-api is down", status=503)

            async def synthesize(self, text: str, **kw: Any) -> bytes:
                return b""

            async def close(self) -> None:
                pass

        app_with_voice.state.voice = FailingVoice()
        c = TestClient(app_with_voice)
        resp = c.post(
            "/turn",
            files={"audio": ("audio.webm", BytesIO(FAKE_AUDIO), "audio/webm")},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 502
        assert "voice-api is down" in resp.json()["error"]
