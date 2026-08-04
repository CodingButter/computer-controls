"""Tests for the HMAC session bearer-token system."""

import time

import pytest

from server.auth import (
    TOKEN_PREFIX,
    TokenError,
    check_secret,
    mint_token,
    verify_token,
)

SECRET = "test-shared-secret-xyz"


# --- mint / verify round-trip -----------------------------------------------

class TestMintVerify:
    def test_minted_token_verifies(self) -> None:
        token = mint_token(SECRET, ttl_s=3600)
        assert token.startswith(TOKEN_PREFIX)
        exp = verify_token(token, SECRET)
        assert exp > time.time()

    def test_each_mint_produces_unique_token(self) -> None:
        a = mint_token(SECRET, ttl_s=3600)
        b = mint_token(SECRET, ttl_s=3600)
        assert a != b  # unique nonce

    def test_verify_returns_expiry(self) -> None:
        token = mint_token(SECRET, ttl_s=7200)
        exp = verify_token(token, SECRET)
        assert abs(exp - (time.time() + 7200)) < 5


# --- tamper detection --------------------------------------------------------

class TestTamper:
    def test_wrong_secret_rejected(self) -> None:
        token = mint_token(SECRET, ttl_s=3600)
        with pytest.raises(TokenError, match="invalid signature"):
            verify_token(token, "different-secret")

    def test_flipped_char_rejected(self) -> None:
        token = mint_token(SECRET, ttl_s=3600)
        # Flip the last hex character of the signature.
        tampered = token[:-1] + ("0" if token[-1] != "0" else "1")
        with pytest.raises(TokenError, match="invalid signature"):
            verify_token(tampered, SECRET)

    def test_missing_prefix_rejected(self) -> None:
        with pytest.raises(TokenError, match="prefix"):
            verify_token("bogus", SECRET)

    def test_malformed_token_rejected(self) -> None:
        with pytest.raises(TokenError, match="malformed"):
            verify_token(f"{TOKEN_PREFIX}garbage", SECRET)


# --- expiry ------------------------------------------------------------------

class TestExpiry:
    def test_expired_token_rejected(self) -> None:
        token = mint_token(SECRET, ttl_s=-1)
        with pytest.raises(TokenError, match="expired"):
            verify_token(token, SECRET)


# --- secret comparison -------------------------------------------------------

class TestCheckSecret:
    def test_matching_secret_accepted(self) -> None:
        assert check_secret(SECRET, SECRET) is True

    def test_mismatched_secret_rejected(self) -> None:
        assert check_secret("wrong", SECRET) is False

    def test_empty_secret_rejected(self) -> None:
        assert check_secret("", SECRET) is False
