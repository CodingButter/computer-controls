"""Tests for the FastAPI server skeleton (no daemon required)."""

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server.app import create_app
from server.auth import mint_token
from server.config import ServerConfig

SECRET = "integration-test-secret"
CONFIG = ServerConfig(
    shared_secret=SECRET,
    daemon_socket_path="/nonexistent/for/tests.sock",
)


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(CONFIG))


# --- /healthz ----------------------------------------------------------------

class TestHealth:
    def test_returns_ok(self, client: TestClient) -> None:
        resp = client.get("/healthz")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


# --- POST /session -----------------------------------------------------------

class TestSession:
    def test_valid_secret_yields_token(self, client: TestClient) -> None:
        resp = client.post("/session", json={"secret": SECRET})
        assert resp.status_code == 200
        body = resp.json()
        assert "token" in body
        assert body["token"].startswith("cc_")

    def test_wrong_secret_rejected(self, client: TestClient) -> None:
        resp = client.post("/session", json={"secret": "nope"})
        assert resp.status_code == 401

    def test_empty_secret_rejected(self, client: TestClient) -> None:
        resp = client.post("/session", json={"secret": ""})
        assert resp.status_code == 401

    def test_no_secret_configured(self) -> None:
        cfg = ServerConfig(shared_secret="", daemon_socket_path="/x.sock")
        c = TestClient(create_app(cfg))
        resp = c.post("/session", json={"secret": "anything"})
        assert resp.status_code == 503


# --- WS /ws ------------------------------------------------------------------

class TestWebSocket:
    def test_valid_token_accepted_no_daemon(self, client: TestClient) -> None:
        """Valid token passes auth; without a daemon the client gets an error."""
        token = mint_token(SECRET, ttl_s=3600)
        with client.websocket_connect(f"/ws?token={token}") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "error"
            assert msg["code"] == "BACKEND_UNAVAILABLE"

    def test_missing_token_rejected(self, client: TestClient) -> None:
        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()
        assert exc_info.value.code == 4401

    def test_invalid_token_rejected(self, client: TestClient) -> None:
        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws?token=bogus") as ws:
                ws.receive_json()
        assert exc_info.value.code == 4401

    def test_expired_token_rejected(self, client: TestClient) -> None:
        token = mint_token(SECRET, ttl_s=-1)
        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect(f"/ws?token={token}") as ws:
                ws.receive_json()
        assert exc_info.value.code == 4401
