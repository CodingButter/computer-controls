# How Factory rides Mastra Code, and what our client takes from it

Read against the monorepo checkout of 2026-07-30 (`mastracode/factory`, `mastracode/sdk`, `packages/_internals/voice`, `voice/*`). Every claim below is from source, with the file named. The purpose: build the client without re-inventing a single wheel Factory already turned.

## 1. What Factory actually is

Factory is a thin composition layer, not a platform. `MastraFactory` (`factory/src/factory.ts`) does three things:

1. `prepare()` resolves feature readiness, threads dependencies explicitly, assembles web routes and middleware, and returns constructor args for `new Mastra(...)`. The literal `export const mastra = new Mastra(...)` must stay in the consumer's entry file (the deployer's Babel plugin looks for it in the AST).
2. `finalize()` runs post-construct boot: controller init plus workers.
3. Everything heavy is delegated: sessions to `prepareAgentControllerMount` from `@mastra/code-sdk`, storage to registered domains, auth to a pluggable `IMastraAuthProvider`.

Our client is the same shape with a different day job. Where Factory mounts a sandbox fleet and GitHub integrations, we mount the desktop plugin and a voice lane.

## 2. Provider account login: solved, wholesale

This is the part Jamie asked about directly, and it is better than hoped. The OAuth primitives are not Factory code. They live in the SDK itself:

- `@mastra/code-sdk/auth/providers/anthropic`: `startAnthropicLogin()` / `completeAnthropicLogin(code, verifier)`. Paste-code PKCE. Log in with your Anthropic account, paste one code, done.
- `@mastra/code-sdk/auth/providers/openai-codex`: `startCodexDeviceLogin()` / `pollCodexDeviceLogin()`. RFC 8628 device flow against the ChatGPT account.
- Same shape for `github-copilot` and `xai` (`factory/src/routes/provider-credentials.ts`, `WEB_OAUTH_FLOW_KINDS`).

Factory wraps these in five HTTP routes (`factory/src/routes/oauth.ts`): `oauth/start`, `oauth/complete`, `oauth/poll`, `oauth/session/:id`, and a flow-listing route. Design facts worth copying verbatim:

- **Tokens never leave the server.** Responses carry flow metadata only (URLs, user codes, poll delays).
- **Flow state lives in login sessions** so a flow can span requests: the `oauth_login_sessions` table in tenant mode, an in-memory libsql store in local mode.
- **Two deployment shapes, one code path** (`resolveCredentialContext`): local mode writes to the file-backed `AuthStorage` (`auth.json`, identical to TUI behavior); tenant mode writes user-scoped rows in the `model-credentials` domain. Our deb is local mode on day one and grows into tenant mode without a rewrite.
- **Catalog id vs auth id**: OpenAI credentials are stored under `openai-codex` (`getAuthProviderId`). One lookup serves both OAuth tokens and API keys.

**Open question, flagged honestly:** the Codex device flow mints a ChatGPT-plan token. Whether that token is accepted by the OpenAI *voice* APIs (TTS, Whisper, Realtime) is unverified. The voice lane may need a plain API key even when the brain rides an OAuth login. Acceptance test: a TTS round trip using each credential kind, recorded either way.

## 3. Dashboard auth: provider-neutral, capability-first

`factory/src/auth.ts` gates every route behind an `IMastraAuthProvider` composed by capability type guards (`isSessionProvider`, `isSSOProvider`, `isAuthHttpHandler`, `isOrganizationsProvider`). Browser navigations redirect to `/signin`, API calls get 401, a small public allowlist stays reachable. When no provider is configured the whole gate is a no-op.

Takeaway for us: ship the deb with no auth adapter (single user on their own machine, the Plex model) and the same code carries better-auth or WorkOS later. We write zero auth code now and lose nothing.

## 4. Storage domains: the extension pattern

Factory extends storage by registering domains onto a `FactoryStorage` (`storage.registerDomain(new ModelCredentialsStorage())`), each domain owning its tables, with libsql serving local mode and Postgres serving tenant mode. Domains that exist today and that we reuse untouched:

| Domain | What it holds | Our use |
|---|---|---|
| `credentials` | provider OAuth tokens + API keys, login sessions | identical |
| `model-packs` | named model tiers per role | identical; scope-brain (A16) maps onto packs |
| `custom-providers` | user-added OpenAI-compatible endpoints | Standard mode's local models |
| `audit` | agent action provenance | feeds the dashboard feed alongside the daemon's own audit log |
| `work-items`, `source-control`, `intake`, `integrations` | the board | not day one; the pattern is there when we want task queues |

New domains we add the same way: desktop grants history, credential vault metadata (the vault values themselves stay out of any model-reachable path), pairing (QR) sessions.

## 5. What we deliberately do not take

- **SandboxFleet** (`factory/src/sandbox/fleet.ts`): Factory isolates coding agents in sandboxes per work item. Our sessions must touch the real desktop; isolation is the daemon's consent ceiling, not a filesystem jail. Nothing to port.
- **GitHub/Linear integrations** (the largest files in the package): not our product.
- **The rules engine** (`factory/src/rules/`): dispatcher, phase processors, transition service. Not needed day one, but this is the proven shape for "a decision fires when a thing changes state" and it is where our A14-style approval flows would land if they ever outgrow the daemon's send gate. Noted, not ported.

## 6. Voice: Mastra already built the whole lane

Jamie's instinct was right. Voice is first-class in Mastra core:

- **`Agent.voice`** is a constructor field with a per-request resolver (`getVoice()`), `packages/core/src/agent/agent.ts:555`.
- **`MastraVoice`** abstract (`packages/_internals/voice/src/voice.ts`): `speak()`, `listen()`, `connect()`, event map. Every provider implements it.
- **`CompositeVoice`** (`composite-voice.ts`): `{ input, output, realtime }`. Mix providers: one for STT, one for TTS, optionally a realtime provider that takes over both. Auto-wraps plain AI SDK transcription/speech models.
- **Server routes ship in core**: `/agents/:agentId/voice/speak`, `/voice/listen`, `/voice/speakers` (`packages/_internals/voice/src/routes`). The browser client calls HTTP endpoints that already exist.
- **`@mastra/voice-openai`**: whisper-1 STT + tts-1 TTS. Request/response, simple, seconds of latency.
- **`@mastra/voice-openai-realtime`**: WebSocket to OpenAI Realtime, server-side VAD (`turn_detection: server_vad`), per-utterance transcription events, `addTools()` / `addInstructions()`, and a relay mode. This is the fluent tier: barge-in, instant acknowledgement, sub-second turnarounds.

**The brain split Jamie specified (OpenAI voice, Anthropic brains) maps exactly onto `CompositeVoice`:** input and output are OpenAI voice providers, the agent underneath is whatever the model pack says (Anthropic). The realtime provider is used in *transcription* mode, not speech-to-speech mode, precisely so the reasoning stays with the pack's brain instead of being captured by OpenAI's realtime model.

**Recommended build order, Mastra's way first:**
1. **Tier 1 (ship first):** `CompositeVoice({ input: OpenAIVoice STT, output: OpenAIVoice TTS })` on the client agent, driven through the core voice routes. Proves the whole loop with zero custom transport.
2. **Tier 2 (fluency):** swap in `OpenAIRealtimeVoice` for the mic path: browser streams audio over a WebSocket to the hub, hub relays to OpenAI Realtime with server VAD, transcription events feed the Anthropic agent, agent text streams back out through TTS. Barge-in comes from VAD interrupting TTS playback client-side.

## 7. The reuse ledger

| Concern | Factory's answer | Our action |
|---|---|---|
| Drive headless sessions | `prepareAgentControllerMount` (code-sdk) | reuse |
| Provider OAuth (Anthropic, OpenAI, Copilot, xAI) | SDK auth primitives + oauth routes | reuse, port routes |
| Credential storage, local + tenant | `model-credentials` domain + `auth.json` | reuse |
| Model packs / custom providers | storage domains + config routes | reuse |
| Dashboard sign-in | capability-first auth gate | reuse (off by default) |
| SPA serving | `spa-static.ts` | reuse |
| Voice | core `Agent.voice` + CompositeVoice + voice routes + OpenAI providers | reuse, wire up |
| Desktop capability | none (ours) | the plugin, already shipped |
| Consent / audit / presence | none (ours) | the daemon, already shipped |
| Sandboxes, GitHub, Linear, board | Factory-specific | skip |

The honest summary: the client is mostly assembly. The two genuinely new pieces are the browser audio transport for the fluent tier and the credential vault. Everything else is a proven Factory part bolted to our daemon.
