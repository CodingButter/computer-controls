"""The documented entry point has to actually start something.

``docs/09-the-first-client.md`` tells an operator to run ``python -m server``.
An empty ``__main__.py`` satisfies the import machinery and exits 0, so the
runbook's own command can silently do nothing — which is exactly what shipped
before this test existed. These tests assert the module has a real main(), that
it refuses to start without the two values it cannot invent, and that it hands
the right listener arguments to uvicorn.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

import server.__main__ as entrypoint

ROOT = Path(__file__).resolve().parents[2]


class TestEntrypointIsNotEmpty:
    def test_module_defines_main(self) -> None:
        assert callable(entrypoint.main)

    def test_module_actually_runs_main(self) -> None:
        """The regression that shipped: a 0-byte __main__.py.

        Asserting the file is merely non-empty would pass on a lone comment,
        so this asserts the two things that make ``python -m server`` do
        something: a main() and a __main__ guard that calls it.
        """
        source = Path(entrypoint.__file__).read_text()
        assert source.strip(), "server/__main__.py is empty"
        assert "def main(" in source
        assert '__name__ == "__main__"' in source
        assert "main()" in source.split('__name__ == "__main__"')[-1]


class TestRefusesIncompleteConfig:
    """Without a secret or a socket path every request would fail anyway."""

    def _run(self, env_extra: dict[str, str]) -> subprocess.CompletedProcess[str]:
        # Inherit the real environment (uvicorn lives in site-packages), then
        # clear the two variables under test so the parent shell cannot mask
        # a missing-config failure.
        env = dict(os.environ)
        env.pop("COMPUTER_CONTROLS_SECRET", None)
        env.pop("COMPUTER_CONTROLS_SOCKET", None)
        env["PYTHONPATH"] = str(ROOT)
        env.update(env_extra)
        return subprocess.run(
            [sys.executable, "-m", "server"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def test_no_config_at_all_exits_nonzero(self) -> None:
        result = self._run({})
        assert result.returncode != 0
        assert "COMPUTER_CONTROLS_SECRET" in result.stderr

    def test_missing_socket_is_named(self) -> None:
        result = self._run({"COMPUTER_CONTROLS_SECRET": "s3cret"})
        assert result.returncode != 0
        assert "COMPUTER_CONTROLS_SOCKET" in result.stderr
        assert "COMPUTER_CONTROLS_SECRET" not in result.stderr


class TestRefusesHalfConfiguredTLS:
    """uvicorn enables TLS when EITHER of cert/key is set.

    With only one of the pair it gets as far as loading the certificate chain
    before failing, so the operator sees a traceback from inside uvicorn rather
    than the mistake they actually made — and the startup log has already
    claimed TLS was off.
    """

    @pytest.fixture
    def base_env(self, monkeypatch) -> None:
        monkeypatch.setenv("COMPUTER_CONTROLS_SECRET", "s3cret")
        monkeypatch.setenv("COMPUTER_CONTROLS_SOCKET", "/run/daemon.sock")
        monkeypatch.delenv("TLS_CERT_PATH", raising=False)
        monkeypatch.delenv("TLS_KEY_PATH", raising=False)

    def test_cert_without_key_refuses(self, base_env, monkeypatch, capsys) -> None:
        monkeypatch.setenv("TLS_CERT_PATH", "/tls/cert.pem")
        assert entrypoint.main() == 2
        assert "TLS_KEY_PATH" in capsys.readouterr().err

    def test_key_without_cert_refuses(self, base_env, monkeypatch, capsys) -> None:
        monkeypatch.setenv("TLS_KEY_PATH", "/tls/key.pem")
        assert entrypoint.main() == 2
        assert "TLS_CERT_PATH" in capsys.readouterr().err


class TestServesWithUvicorn:
    """main() reaches uvicorn.run with the configured listener and TLS."""

    @pytest.fixture
    def captured(self, monkeypatch) -> dict[str, Any]:
        calls: dict[str, Any] = {}

        def fake_run(app: Any, **kwargs: Any) -> None:
            calls["app"] = app
            calls["kwargs"] = kwargs

        monkeypatch.setattr(entrypoint.uvicorn, "run", fake_run)
        return calls

    def test_passes_host_and_port(self, captured, monkeypatch) -> None:
        monkeypatch.setenv("COMPUTER_CONTROLS_SECRET", "s3cret")
        monkeypatch.setenv("COMPUTER_CONTROLS_SOCKET", "/run/daemon.sock")
        monkeypatch.setenv("HOST", "127.0.0.1")
        monkeypatch.setenv("PORT", "9443")

        assert entrypoint.main() == 0
        assert captured["kwargs"]["host"] == "127.0.0.1"
        assert captured["kwargs"]["port"] == 9443
        # No TLS material configured — uvicorn must get None, not "".
        assert captured["kwargs"]["ssl_certfile"] is None
        assert captured["kwargs"]["ssl_keyfile"] is None

    def test_passes_tls_material(self, captured, monkeypatch) -> None:
        monkeypatch.setenv("COMPUTER_CONTROLS_SECRET", "s3cret")
        monkeypatch.setenv("COMPUTER_CONTROLS_SOCKET", "/run/daemon.sock")
        monkeypatch.setenv("TLS_CERT_PATH", "/tls/cert.pem")
        monkeypatch.setenv("TLS_KEY_PATH", "/tls/key.pem")

        assert entrypoint.main() == 0
        assert captured["kwargs"]["ssl_certfile"] == "/tls/cert.pem"
        assert captured["kwargs"]["ssl_keyfile"] == "/tls/key.pem"

    def test_builds_a_real_app(self, captured, monkeypatch) -> None:
        monkeypatch.setenv("COMPUTER_CONTROLS_SECRET", "s3cret")
        monkeypatch.setenv("COMPUTER_CONTROLS_SOCKET", "/run/daemon.sock")

        assert entrypoint.main() == 0
        # The served object is the configured FastAPI app, not a factory.
        assert {r.path for r in captured["app"].routes} >= {
            "/healthz",
            "/session",
            "/turn",
        }
