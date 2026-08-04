"""FastAPI server factory: health, session trade, and auth-gated WebSocket.

This is the server layer — a distinct process that sits between clients
(the PWA, any future client) and the daemon.  It owns the only daemon
connections (Phase 3), so a client never reaches the daemon's ``0600`` unix
socket directly.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import (
    Depends,
    FastAPI,
    Header,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .agent import Agent, StubAgent
from .auth import (
    TokenError,
    check_secret,
    mint_token,
    verify_token,
)
from .config import ServerConfig
from .daemon_client import DaemonError
from .session import Session
from .voice import VoiceClient, VoiceError

log = logging.getLogger(__name__)

TAG = "computer-controls/server"


class SessionRequest(BaseModel):
    secret: str


def create_app(config: ServerConfig) -> FastAPI:
    """Build the FastAPI application from ``config``."""
    app = FastAPI(
        title="Computer Controls Server",
        description=(
            "The server layer between clients and the desktop-service daemon. "
            "Owns the only daemon connections — clients never reach the "
            "daemon's unix socket directly."
        ),
        version="0.1.0",
    )
    app.state.config = config
    app.state.voice = VoiceClient(config.voice_api_url) if config.voice_api_url else None
    app.state.agent: Agent = StubAgent()

    async def require_bearer(
        authorization: str = Header(default=""),
    ) -> bool:
        """Extract and verify the bearer token from the Authorization header."""
        if not authorization.startswith("Bearer "):
            return False
        token = authorization[len("Bearer ") :]
        try:
            verify_token(token, config.shared_secret)
            return True
        except TokenError:
            return False

    # -- /healthz -----------------------------------------------------------
    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    # -- POST /session: trade shared secret → bearer token ------------------
    @app.post("/session")
    async def create_session(req: SessionRequest) -> JSONResponse:
        if not config.shared_secret:
            return JSONResponse(
                status_code=503,
                content={"error": "no shared secret configured on the server"},
            )
        if not check_secret(req.secret, config.shared_secret):
            return JSONResponse(
                status_code=401,
                content={"error": "invalid secret"},
            )
        token = mint_token(config.shared_secret, ttl_s=config.token_ttl_s)
        return JSONResponse(
            status_code=200,
            content={"token": token},
        )

    # -- POST /turn: audio in → STT → agent → TTS → audio out ---------------
    @app.post("/turn")
    async def voice_turn(
        audio: UploadFile,
        authed: bool = Depends(require_bearer),
    ) -> Response:
        if not authed:
            return JSONResponse(
                status_code=401, content={"error": "unauthorized"}
            )

        voice = app.state.voice
        if voice is None:
            return JSONResponse(
                status_code=503,
                content={"error": "voice-api not configured"},
            )

        audio_bytes = await audio.read()
        try:
            text = await voice.transcribe(audio_bytes)
            reply = await app.state.agent.turn(text)
            reply_audio = await voice.synthesize(reply)
        except VoiceError as exc:
            return JSONResponse(
                status_code=502,
                content={"error": str(exc)},
            )

        return Response(
            content=reply_audio,
            media_type="audio/mpeg",
            headers={"X-Transcript": text, "X-Reply": reply},
        )

    # -- WS /ws: auth-gated, token via query param --------------------------
    @app.websocket("/ws")
    async def websocket_endpoint(ws: WebSocket) -> None:
        token = ws.query_params.get("token", "")
        try:
            verify_token(token, config.shared_secret)
        except TokenError:
            await ws.close(code=4401, reason="unauthorized")
            return

        await ws.accept()

        async def _send(msg: dict) -> None:
            try:
                await ws.send_json(msg)
            except Exception:
                pass  # WS closed — the receive loop will catch the disconnect.

        session = Session(config.daemon_socket_path, _send)
        try:
            await session.start()
        except DaemonError as exc:
            await ws.send_json(
                {"type": "error", "code": exc.code, "message": str(exc)}
            )
            await ws.close()
            return

        await ws.send_json(
            {"type": "connected", "clientId": session.client_id}
        )
        try:
            # Keep the connection alive; clients send pings or voice turns.
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            await session.stop()

    # -- Static PWA assets (mounted last so API routes take precedence) -----
    if config.pwa_static_dir and Path(config.pwa_static_dir).is_dir():
        app.mount("/", StaticFiles(directory=config.pwa_static_dir, html=True), name="pwa")

    return app
