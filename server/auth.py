"""Session bearer-token mint/verify backed by HMAC-SHA256.

A client trades the static shared secret (over TLS) for a time-limited bearer
token via ``POST /session``.  The token is ``{exp}.{nonce}.{signature}`` where
the signature is HMAC-SHA256 of ``{exp}.{nonce}`` keyed by the shared secret.
Verification recomputes the signature with a constant-time compare and checks
the expiry.  Revocation is out of scope (A4) — a token is valid until it
expires.
"""

from __future__ import annotations

import hmac
import hashlib
import secrets
import time

#: Tokens are unguessable because of the HMAC, but callers may want a prefix
#: check before the full verify — this is that prefix.
TOKEN_PREFIX = "cc_"

_DELIM = "."


def _sign(secret: str, message: str) -> str:
    return hmac.new(
        secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def mint_token(secret: str, *, ttl_s: int = 8 * 60 * 60) -> str:
    """Mint a time-limited bearer token signed with ``secret``."""
    exp = int(time.time()) + ttl_s
    nonce = secrets.token_hex(16)
    message = f"{exp}{_DELIM}{nonce}"
    sig = _sign(secret, message)
    return f"{TOKEN_PREFIX}{exp}{_DELIM}{nonce}{_DELIM}{sig}"


class TokenError(Exception):
    """Raised when a token is malformed, tampered, or expired."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def verify_token(token: str, secret: str) -> int:
    """Verify a bearer token and return the expiry epoch.

    Raises ``TokenError`` on any failure (malformed, tampered, expired).
    """
    if not token.startswith(TOKEN_PREFIX):
        raise TokenError("missing token prefix")
    body = token[len(TOKEN_PREFIX) :]

    parts = body.split(_DELIM)
    if len(parts) != 3:
        raise TokenError("malformed token")

    exp_str, nonce, sig = parts
    try:
        exp = int(exp_str)
    except ValueError:
        raise TokenError("malformed expiry")

    expected = _sign(secret, f"{exp}{_DELIM}{nonce}")
    if not hmac.compare_digest(expected, sig):
        raise TokenError("invalid signature")

    if exp < time.time():
        raise TokenError("token expired")

    return exp


def check_secret(provided: str, expected: str) -> bool:
    """Constant-time comparison of the shared secret."""
    return hmac.compare_digest(provided, expected)
