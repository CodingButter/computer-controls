"""Tests for the voice path: POST /turn (mock VoiceClient + StubAgent).

No real voice-api required (--no-live safe). The StubAgent proves the
end-to-end path: audio → STT → agent turn → TTS → audio reply.
"""

from __future__ import annotations

from io import BytesIO
from typing import Any
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient

from server.agent import StubAgent
from server.app import MAX_HEADER_TEXT_BYTES, create_app
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
        # The transcript and reply are surfaced in headers for debugging,
        # percent-encoded so any language survives the latin-1 header wire.
        assert unquote(resp.headers["X-Transcript"]) == "hello computer"
        assert "You said" in unquote(resp.headers["X-Reply"])

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


class TestTurnNonLatin1Speech:
    """Speech is not latin-1, and HTTP headers are.

    A transcript in Chinese, Japanese, Arabic, or one carrying an emoji used to
    raise UnicodeEncodeError as the response was serialised, so the caller got a
    500 instead of the audio reply that had already been synthesised.
    """

    @pytest.mark.parametrize(
        "transcript",
        [
            "你好世界",           # Chinese
            "こんにちは",          # Japanese
            "مرحبا بالعالم",      # Arabic
            "Привет мир",         # Cyrillic
            "hello 😀 computer",  # emoji beyond the BMP
            "naïve café",         # latin-1 representable — must still work
        ],
    )
    def test_returns_audio_not_500(self, transcript: str) -> None:
        class UnicodeVoice:
            async def transcribe(self, audio_bytes: bytes) -> str:
                return transcript

            async def synthesize(self, text: str, **kw: Any) -> bytes:
                return b"fake-mp3-audio-reply"

            async def close(self) -> None:
                pass

        cfg = ServerConfig(
            shared_secret=SECRET,
            daemon_socket_path="/nonexistent.sock",
            voice_api_url="http://fake-voice-api",
        )
        app = create_app(cfg)
        app.state.voice = UnicodeVoice()
        app.state.agent = StubAgent()
        c = TestClient(app)
        resp = c.post(
            "/turn",
            files={"audio": ("audio.webm", BytesIO(FAKE_AUDIO), "audio/webm")},
            headers={"Authorization": f"Bearer {mint_token(SECRET, ttl_s=3600)}"},
        )

        assert resp.status_code == 200
        assert resp.content == b"fake-mp3-audio-reply"
        # The transcript round-trips through the header intact.
        assert unquote(resp.headers["X-Transcript"]) == transcript
        # Every header value is actually sendable on the wire.
        for value in resp.headers.values():
            value.encode("latin-1")


class TestTurnLongTranscript:
    """A long transcript must not blow the response's header budget.

    Percent-encoding inflates CJK ninefold — three UTF-8 bytes become nine
    ASCII characters — so a spoken paragraph in Chinese reaches 8 KB in a
    single header. Proxies reject the whole response over that, which would
    trade the original 500 for a 502.
    """

    def _post(self, transcript: str):
        class LongVoice:
            async def transcribe(self, audio_bytes: bytes) -> str:
                return transcript

            async def synthesize(self, text: str, **kw: Any) -> bytes:
                return b"fake-mp3-audio-reply"

            async def close(self) -> None:
                pass

        cfg = ServerConfig(
            shared_secret=SECRET,
            daemon_socket_path="/nonexistent.sock",
            voice_api_url="http://fake-voice-api",
        )
        app = create_app(cfg)
        app.state.voice = LongVoice()
        app.state.agent = StubAgent()
        return TestClient(app).post(
            "/turn",
            files={"audio": ("audio.webm", BytesIO(FAKE_AUDIO), "audio/webm")},
            headers={"Authorization": f"Bearer {mint_token(SECRET, ttl_s=3600)}"},
        )

    def test_long_cjk_transcript_is_bounded(self) -> None:
        resp = self._post("这是一个很长的句子用来测试标头的大小限制" * 45)
        assert resp.status_code == 200
        assert resp.content == b"fake-mp3-audio-reply"
        assert len(resp.headers["X-Transcript"]) <= MAX_HEADER_TEXT_BYTES

    def test_long_ascii_transcript_is_bounded(self) -> None:
        resp = self._post("a long spoken sentence about the desktop " * 60)
        assert resp.status_code == 200
        assert len(resp.headers["X-Transcript"]) <= MAX_HEADER_TEXT_BYTES

    def test_truncated_value_still_decodes(self) -> None:
        """Truncation must not sever a percent-escape or a UTF-8 sequence."""
        resp = self._post("这是一个很长的句子用来测试标头的大小限制" * 45)
        decoded = unquote(resp.headers["X-Transcript"])
        assert decoded.endswith("…")
        # No replacement characters — the cut landed on a character boundary.
        assert "\ufffd" not in decoded

    def test_short_transcript_is_not_truncated(self) -> None:
        resp = self._post("你好世界")
        assert unquote(resp.headers["X-Transcript"]) == "你好世界"


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
