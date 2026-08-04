# Triage: issue #105 — The orb: a voice-first face with a local wake gate

**Verdict: valid and actionable → planning.**

This is a feature spec authored by the repo owner, not a bug report. It gives
the product a second face — a voice-first orb page with a local wake gate —
over the same headless session the chat page already serves. No duplicate
exists; no related PR has been opened. Nothing about the spec is
working-as-designed or invalid.

## What the orb changes, and what it leaves alone

**New surfaces:**
- A new primary page: one circular presence on dark ground, chat log demoted to
  a drawer. The existing chat page stays (orb is a second face, not a fork).
- A bidirectional streaming voice session (Gemini Live), distinct from the
  existing OpenAI request/response lane (`client/src/voice/`).
- A local wake gate: Tier 0 VAD (Silero-class, ~1MB) + Tier 1 Moonshine tiny
  English (26MB, CPU, MIT) transcribe + classify intent. Audio forwards to the
  realtime provider only after the gate opens.
- An utterance bank: short ack clips synthesized once, cached on disk, played
  as filler while the real response streams in.
- A one-mouth audio queue: a started utterance plays to completion; only a
  human can barge in.

**Untouched:** the daemon, the protocol, the desktop plugin's tools, the model
pack. The orb is a client-side face + a new voice path into the same hub.

## Architectural fit — confirmed against source

| Concern | Where it lands | Evidence |
|---|---|---|
| Same session, same thread | `hub.ts` mints one session per `BROWSER_RESOURCE_ID="local-browser"`; orb and chat page share it | `client/src/hub.ts:85-91` |
| Actionable → one function call | `AgentTurn` (`chat.ts`) is the single bridge from voice to brain; the Live provider holds no desktop/memory tools — the function call routes through `createAgentTurn` | `client/src/chat.ts:42-61` |
| Google credential in same store | `AuthStorageCredentialStore` is extensible; add `google` to `PROVIDER_IDS` + `PROVIDERS` in `auth/providers.ts` (currently only `anthropic`, `openai`) | `client/src/auth/providers.ts:35-52` |
| Signals → orb as text turns | Plugin `signals/` lane exists; `@mastra/code-sdk` 1.1.1 has no `signalProviders` surface yet (upstream PR mastra-ai/mastra#20554, open) — hedge per issue comment: hub-side injection behind an interface | `plugin/src/signals/`, issue comment 2026-08-04 |
| The orb is a new SPA route | `ui.ts` SPA fallback already supports client-side routing; add `/orb` page (or make orb default) | `client/src/ui.ts:27-41` |
| Brain stays Tier 2 | `model-pack.ts` resolves the standard-tier model (`sonnet-4-6`) the function call reaches; Live never sees it | `client/src/model-pack.ts:41-48` |

## Three dependency gaps — all known, all hedged

1. **`@mastra/voice-google-gemini-live-api` does not exist on npm** (404,
   confirmed). The issue allows "raw Live API" as the alternative. `@mastra/voice-google`
   (v0.14.0) exists but is request/response, not bidirectional streaming. The
   realtime provider must be built against Google's Live API WebSocket directly,
   or behind an interface so the package can slot in when published.

2. **Plugin `signalProviders`/`processors` surface** is not in
   `@mastra/code-sdk` 1.1.1 (upstream PR #20554, still open). The issue author's
   own comment prescribes the hedge: hub-side injection behind an interface —
   the hub owns the session, so qualifying signals push as text turns from hub
   code directly. Swapping to the plugin lane later is a few-line change.

3. **Moonshine non-English models are non-commercial** (community license). The
   shipped ear is English-only until that licensing conversation happens.
   Moonshine English models are MIT — confirmed by the issue spec.

## Open decisions for planning (not blockers)

- **Where does the wake gate run?** Browser (ONNX Runtime Web / WASM) or hub
  process (Node native bindings)? The privacy property — "idle mode sends no
  audio off the machine" — holds either way, but the runtime location is a
  planning decision with real tradeoffs (latency, bundle size, mic access).
- **Gemini Live transport: raw WebSocket vs wait for package.** The issue allows
  raw; planning decides whether to build the WebSocket client now or behind an
  interface.
- **Orb as default route or explicit `/orb`.** Both pages share the session;
  routing is a UX decision.
- **Utterance bank voice identity.** Clips synthesized in "product voice" —
  same speaker as the existing lane (`nova`), or a Gemini Live voice, or a
  third? The bank is cached, so this is a one-time synthesis decision.

## Named acceptance tests (from the issue)

All seven are testable against the architecture as understood:

1. `test_idle_mode_sends_no_audio_off_the_machine`
2. `test_the_wake_gate_opens_only_when_the_cheap_ear_says_so`
3. `test_a_signal_injected_as_text_is_spoken_by_the_orb`
4. `test_the_live_provider_holds_no_desktop_or_memory_tools`
5. `test_actionable_requests_route_to_the_pack_brain_as_one_function_call`
6. `test_a_filler_clip_plays_from_cache_and_never_from_a_live_synth_call`
7. `test_the_real_response_never_starts_before_the_playing_utterance_ends`
