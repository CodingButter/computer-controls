"""Entry point: ``python -m server``.

Reads configuration from the environment, builds the FastAPI application, and
serves it with uvicorn.  TLS is enabled when both a certificate and a key are
configured — a phone needs HTTPS before it will grant microphone access or
offer to install the PWA.

The two values the server cannot invent are the shared secret (clients trade it
for a bearer token) and the daemon socket path (where it opens one connection
per agent).  Starting without them would yield a server that accepts
connections and refuses every one of them, so this refuses to start instead.
"""

from __future__ import annotations

import logging
import sys

import uvicorn

from .app import create_app
from .config import load_config


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log = logging.getLogger("server")

    config = load_config()

    missing = []
    if not config.shared_secret:
        missing.append("COMPUTER_CONTROLS_SECRET")
    if not config.daemon_socket_path:
        missing.append("COMPUTER_CONTROLS_SOCKET")
    if missing:
        print(
            "server: refusing to start without "
            + " and ".join(missing)
            + "\nSee docs/09-the-first-client.md for the runbook.",
            file=sys.stderr,
        )
        return 2

    # uvicorn turns TLS on when EITHER of cert/key is set, then fails deep in
    # its own startup once the pair turns out to be incomplete. Half-configured
    # TLS is always an operator mistake, so name it here instead.
    if bool(config.tls_cert_path) != bool(config.tls_key_path):
        have, want = (
            ("TLS_CERT_PATH", "TLS_KEY_PATH")
            if config.tls_cert_path
            else ("TLS_KEY_PATH", "TLS_CERT_PATH")
        )
        print(
            f"server: {have} is set but {want} is not. "
            "TLS needs both or neither.",
            file=sys.stderr,
        )
        return 2

    scheme = "https" if config.tls_enabled else "http"
    log.info("daemon socket: %s", config.daemon_socket_path)
    log.info(
        "voice-api: %s",
        config.voice_api_url or "(not configured — /turn will answer 503)",
    )
    if config.pwa_static_dir:
        log.info("serving PWA from: %s", config.pwa_static_dir)
    if not config.tls_enabled:
        log.warning(
            "TLS is off. A phone needs HTTPS for microphone access and PWA "
            "install — set TLS_CERT_PATH and TLS_KEY_PATH."
        )
    log.info("listening on %s://%s:%d", scheme, config.host, config.port)

    uvicorn.run(
        create_app(config),
        host=config.host,
        port=config.port,
        ssl_certfile=config.tls_cert_path or None,
        ssl_keyfile=config.tls_key_path or None,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
