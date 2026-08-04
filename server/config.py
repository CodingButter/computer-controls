"""Typed server configuration loaded from environment variables.

The server layer is a distinct middle process — it reads a shared secret
(for the one-time-token trade), the daemon socket path (where it opens one
unix connection per agent), TLS material, and the voice-api base URL (Phase 4).
Nothing here touches the daemon's own configuration.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8443
DEFAULT_TOKEN_TTL_S = 8 * 60 * 60  # 8 hours


@dataclass(frozen=True)
class ServerConfig:
    shared_secret: str
    daemon_socket_path: str
    voice_api_url: str = ""
    tls_cert_path: str = ""
    tls_key_path: str = ""
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    token_ttl_s: int = DEFAULT_TOKEN_TTL_S
    pwa_static_dir: str = ""

    @property
    def tls_enabled(self) -> bool:
        return bool(self.tls_cert_path and self.tls_key_path)


def load_config(
    *,
    shared_secret: str | None = None,
    daemon_socket_path: str | None = None,
    **overrides: object,
) -> ServerConfig:
    """Build a ``ServerConfig`` from explicit args, then environment, then defaults."""
    fields: dict[str, object] = {}

    def _resolve(key: str, env: str, default: object) -> None:
        if key in overrides and overrides[key] is not None:
            fields[key] = overrides[key]
        elif env in os.environ:
            fields[key] = os.environ[env]
        else:
            fields[key] = default

    _resolve("shared_secret", "COMPUTER_CONTROLS_SECRET", shared_secret or "")
    _resolve(
        "daemon_socket_path",
        "COMPUTER_CONTROLS_SOCKET",
        daemon_socket_path or "",
    )
    _resolve("voice_api_url", "VOICE_API_URL", "")
    _resolve("tls_cert_path", "TLS_CERT_PATH", "")
    _resolve("tls_key_path", "TLS_KEY_PATH", "")
    _resolve("host", "HOST", DEFAULT_HOST)
    _resolve("port", "PORT", DEFAULT_PORT)
    _resolve("token_ttl_s", "TOKEN_TTL_S", DEFAULT_TOKEN_TTL_S)
    _resolve("pwa_static_dir", "PWA_STATIC_DIR", "")

    port_val = fields["port"]
    if isinstance(port_val, str):
        fields["port"] = int(port_val)

    ttl_val = fields["token_ttl_s"]
    if isinstance(ttl_val, str):
        fields["token_ttl_s"] = int(ttl_val)

    return ServerConfig(**fields)  # type: ignore[arg-type]
