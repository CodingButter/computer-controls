# 09 — The First Client: a PWA You Can Talk To

Issue [#35](https://github.com/CodingButter/computer-controls/issues/35) asked for the first
client that is not the plugin: an installable PWA on a phone that connects to a running service,
shows live desktop state, and lets you speak to it and hear a reply.

This document is the runbook for milestone 1 — the server layer and the PWA shell.

## The three layers

```
 Phone (PWA)                    Server (this code)              Daemon
 ────────────                   ──────────────────              ──────
 URL + credential  ──HTTPS/WSS──>  FastAPI process               AT-SPI, X11,
                                opens ONE unix socket           capture, consent,
                                per agent session               holds, presence
                                over the daemon's 0600 socket
```

The phone never reaches the daemon socket. The server is the only thing that opens it — one
connection per agent, per the [#34](https://github.com/CodingButter/computer-controls/issues/34)
invariant. Identity, grants, element ownership, and disconnect cleanup all key off the connection,
so two agents sharing one connection become one client in four places at once.

## What's in `server/`

| File | Purpose |
| --- | --- |
| `daemon_client.py` | Async JSON-RPC client over the daemon's unix socket. One socket per instance. Hello handshake captures the service-issued clientId. Schema-digest check refuses to attach to a stale daemon ([#30](https://github.com/CodingButter/computer-controls/issues/30)). |
| `session.py` | Owns one `DaemonClient`. Polls `getDeltaSince` and pushes desktop-state deltas to the connected PWA over WebSocket. Re-acquires the full picture via `getDesktopState` when the delta log is incomplete. |
| `app.py` | FastAPI factory: `/healthz`, `POST /session` (secret → bearer token), `WS /ws` (auth-gated relay), `POST /turn` (audio → reply). Mounts built PWA assets as static files. |
| `auth.py` | HMAC-signed bearer tokens with constant-time comparison. Stdlib only. |
| `config.py` | Typed configuration from environment variables. |
| `voice.py` | Proxy to the voice API (`/api/transcribe`, `/api/synthesize`). Swappable: replace this file to embed STT/TTS directly. |
| `agent.py` | `Agent` protocol + `StubAgent`. The stub reflects the current desktop state — a real LLM agent plugs into the protocol. |
| `__main__.py` | Entry point: `python -m server`. |
| `requirements.txt` | fastapi, uvicorn[standard], websockets, httpx, python-multipart. |

Tests live in `server/tests/` — 43 tests including the one-connection-per-agent invariant.

## What's in `clients/web/`

A Vite + vanilla TypeScript PWA:

- `connect.ts` — credential trade: `POST /session` with the shared secret → bearer token.
- `state-view.ts` — renders the live desktop state (window list + focus) from WebSocket deltas.
- `voice.ts` — `MediaRecorder` capture → `POST /turn` → `<audio>` playback.
- `main.ts` — wiring: connect screen, WebSocket consumer, voice button.
- `public/manifest.webmanifest` + `public/sw.js` — installability; the service worker caches
  the shell for offline launch but **never** caches desktop state.
- `public/icons/` — 192px and 512px maskable icons.

Tests in `clients/web/tests/` — 10 vitest tests.

## Running it

### 1. Build the PWA

```sh
cd clients/web
npm install
npm run build        # produces clients/web/dist/
```

### 2. Start the daemon

```sh
python service/server.py
```

Note the socket path it prints (or set `COMPUTER_CONTROLS_SOCKET` explicitly).

### 3. Start the server layer

```sh
export COMPUTER_CONTROLS_SECRET="your-shared-secret"
export COMPUTER_CONTROLS_SOCKET="/run/user/$(id -u)/mastracode-desktop/daemon.sock"
export PWA_STATIC_DIR="$(pwd)/clients/web/dist"
export VOICE_API_URL="http://localhost:8000"   # optional: voice API base URL

python -m server
```

For HTTPS (required for microphone access and PWA install on a phone), set:

```sh
export TLS_CERT_PATH="/path/to/cert.pem"
export TLS_KEY_PATH="/path/to/key.pem"
```

### 4. Open the PWA

Navigate to `https://<server-host>:8443/` on your phone. Enter the shared secret. You should see
the live desktop state and a microphone button.

## Verification

### Automated

```sh
# Python (sandbox-safe lane)
pytest --no-live

# PWA
cd clients/web && npm test && npm run build
```

### The one-connection-per-agent invariant

The load-bearing rule from [#34](https://github.com/CodingButter/computer-controls/issues/34) is
enforced in `server/tests/test_one_connection_per_agent.py`: two sessions yield two distinct daemon
connections and two distinct service-issued clientIds.

To verify in a live deployment:

```sh
ss -x | grep mastracode-desktop
```

Only the **server** process should appear as holding the daemon's unix socket. Phone traffic
terminates at the server's TCP socket and never touches the daemon.

## What milestone 1 does NOT include

- **No LLM agent.** The stub proves the voice path end-to-end. A real agent plugs into the
  `Agent` protocol (`async turn(audio_bytes | text) -> reply`).
- **No streaming or barge-in.** Voice is request/response: record → send → receive → play.
- **No off-LAN reach.** The phone must be on the same network as the server.
  ([#36](https://github.com/CodingButter/computer-controls/issues/36) hard part 1.)
- **No credential revocation.** One shared secret, traded for a session bearer token.
  ([#36](https://github.com/CodingButter/computer-controls/issues/36) hard part 3.)
- **No repo reshape.** [#31](https://github.com/CodingButter/computer-controls/issues/31) is
  still open; this build adds `server/` as a new top-level package without forcing the reshape.
