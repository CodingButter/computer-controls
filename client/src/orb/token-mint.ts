/**
 * The hub mints a constrained ephemeral token, and the key stays home.
 *
 * A client-side mouth needs to dial Google directly — that is the whole point
 * of the migration, every relayed audio frame crosses the network twice — but
 * the stored Google credential must never reach a device. So the hub trades
 * it, on request, for a v1alpha ephemeral token whose constraints are decided
 * here, server-side, and nowhere else: the configured live model, the orb's
 * system instruction, exactly two tools, single use, and clocks tight enough
 * that a stolen token is stale before it travels.
 *
 * The request body accepts no fields from the caller. Every documented
 * ephemeral-token incident — tool injection and worse — starts with a mint
 * that let the requester shape the constraints. An empty body is the only
 * valid request; anything else is refused before the credential is even
 * resolved.
 *
 * Two clocks, verified against the live API rather than assumed:
 * `newSessionExpireTime` bounds when a session may *start* (~60s — the token
 * travels one hop and dials), `expireTime` bounds the token itself (~30min).
 * Constraints are enforced at connect; a session already running is not
 * killed by its own token's clock.
 */

import { Hono } from "hono";

import { isRefusal, resolveRealtimeProvider } from "./credentials.ts";
import { parseRealtimeProviderId } from "./providers.ts";
import { ORB_SYSTEM_INSTRUCTION } from "../live/session.ts";
import { HUB_FUNCTION_DECLARATION, STOP_LISTENING_DECLARATION, LIVE_MODEL, LIVE_VOICE } from "../live/live.ts";
import { readRealtimeSettings } from "./realtime-settings.ts";

export const TOKEN_MINT_PATH = "/api/orb/token";

/** Where ephemeral tokens are minted. The key rides a header, never the URL. */
export const AUTH_TOKENS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1alpha/auth_tokens";

/** The window in which the minted token may start a session. */
export const NEW_SESSION_WINDOW_MS = 60_000;

/** The token's own lifetime. Enforced at connect, not mid-session. */
export const TOKEN_TTL_MS = 30 * 60_000;

/** Where OpenAI mints short-lived client secrets. The key rides the Authorization header. */
export const OPENAI_CLIENT_SECRETS_ENDPOINT = "https://api.openai.com/v1/realtime/client_secrets";

/**
 * How long an OpenAI ephemeral secret lives — tight, because the browser dials
 * immediately after mint. A redial mints fresh: a used token opens nothing.
 */
export const OPENAI_TOKEN_TTL_S = 60;

export type MintedToken = {
  token: string;
  expiresAt: string;
  model: string;
};

export type TokenMintOptions = {
  credentials: Parameters<typeof resolveRealtimeProvider>[0];
  /** Absent means the pinned defaults, the same fallback the orb boot uses. */
  settingsPath?: string;
  /** Injectable so tests assert on the outgoing mint request. */
  fetchFn?: typeof fetch;
};

/**
 * The setup the token is locked to — field-for-field the same
 * BidiGenerateContentSetup frame session.ts builds for the hub's own
 * dial, so a client holding this token can open exactly the session the hub
 * would have opened and no other. With `bidiGenerateContentSetup` present,
 * the API locks every LiveConnectConfig field to these values; a client's
 * attempt to change them at connect is ignored. (The REST field name was
 * verified against the live API during this segment's green leg — the first
 * guess, `liveConnectConstraints`, is the SDK's name, not the wire's.)
 */
function buildSetup(model: string, voice: string) {
  return {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
    systemInstruction: { parts: [{ text: ORB_SYSTEM_INSTRUCTION }] },
    tools: [{ functionDeclarations: [HUB_FUNCTION_DECLARATION, STOP_LISTENING_DECLARATION] }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

/** Default model and voice when no OpenAI-specific setting is chosen. */
const OPENAI_REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17";
const OPENAI_REALTIME_VOICE = "alloy";

/**
 * The session config the OpenAI ephemeral secret is locked to, in the shape
 * `client_secrets` expects. Same discipline as the Gemini setup — the orb's
 * instruction, exactly one tool, both audio modalities — translated to the
 * field names OpenAI's Realtime API reads. A client holding the `ek_` token
 * can open exactly this session and no other.
 */
function buildOpenAISessionConfig(model: string, voice: string) {
  return {
    model,
    voice,
    instructions: ORB_SYSTEM_INSTRUCTION,
    tools: [{
      type: "function",
      name: HUB_FUNCTION_DECLARATION.name,
      description: HUB_FUNCTION_DECLARATION.description,
      parameters: HUB_FUNCTION_DECLARATION.parameters,
    }],
    tool_choice: "auto" as const,
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
    // Server VAD (the default, omitted) matches the orb's wake-gate model:
    // audio streams while unmuted, the server detects speech boundaries and
    // generates responses. turn_detection: null would require explicit
    // client-side commit, which the orb's pipeline does not do.
    input_audio_transcription: { model: "whisper-1" },
    output_audio_transcription: { model: "gpt-4o-transcribe" },
  };
}

/**
 * Shared fetch + error handling for both mint endpoints.
 *
 * Every provider's mint rides a key in a header and names its failures the
 * same way — the upstream's words, minus the one word that is nobody's
 * business. Hoisting the pattern keeps the two branches honest about both
 * sending the key the same way and scrubbing it the same way.
 */
type UpstreamResult =
  | { ok: true; response: Response }
  | { ok: false; status: 502; body: { error: string } };

async function fetchUpstream(
  endpoint: string,
  headers: Record<string, string>,
  body: string,
  key: string,
  doFetch: typeof fetch,
): Promise<UpstreamResult> {
  let upstream: Response;
  try {
    upstream = await doFetch(endpoint, { method: "POST", headers, body });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 502, body: { error: scrub(`The token mint could not be reached: ${reason}`, key) } };
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return {
      ok: false,
      status: 502,
      body: { error: scrub(`The provider refused to mint a token: ${text || upstream.statusText}`, key) },
    };
  }
  return { ok: true, response: upstream };
}

/** The one string that must never leave this process, scrubbed wherever it might hide. */
function scrub(text: string, key: string): string {
  return key ? text.split(key).join("[redacted]") : text;
}

export function buildTokenMintApp(options: TokenMintOptions): Hono {
  const app = new Hono();
  const doFetch = options.fetchFn ?? fetch;

  app.post(TOKEN_MINT_PATH, async (c) => {
    // Refused before the credential is resolved: a caller offering fields is
    // asking to shape the mint, and the answer is no regardless of whether a
    // credential exists to shape.
    const body = await c.req.text();
    if (body.trim() !== "") {
      return c.json(
        { error: "This mint accepts no request body. The constraints are decided here." },
        400,
      );
    }

    // Settings read first — the provider preference lives here, and it
    // decides which credential we resolve and which endpoint we dial.
    // Read per-request, deliberately fresher than the hub's own boot-time
    // read: a token minted after a settings change reflects the new choice.
    const settings = options.settingsPath ? await readRealtimeSettings(options.settingsPath) : {};
    const preference = parseRealtimeProviderId(settings.realtimeProvider);
    const credential = await resolveRealtimeProvider(options.credentials, preference);
    if (isRefusal(credential)) {
      // The product's one credential vocabulary — the same sentence the
      // status route speaks, so a page never has to translate.
      return c.json({ error: credential.reason }, 409);
    }

    if (credential.provider === "openai") {
      // OpenAI Realtime: the hub mints a short-lived client secret. The
      // session config carries the same instruction and one tool, translated
      // to the Realtime API's flat shape. The key rides the Authorization
      // header and never reaches the browser — the ek_ token does.
      const model = settings.realtimeModel ?? OPENAI_REALTIME_MODEL;
      const voice = settings.realtimeVoice ?? OPENAI_REALTIME_VOICE;
      const requestExpiresAt = Math.floor(Date.now() / 1000) + OPENAI_TOKEN_TTL_S;
      const mintRequest = {
        expires_at: requestExpiresAt,
        session_config: buildOpenAISessionConfig(model, voice),
      };

      const result = await fetchUpstream(
        OPENAI_CLIENT_SECRETS_ENDPOINT,
        { "content-type": "application/json", Authorization: `Bearer ${credential.key}` },
        JSON.stringify(mintRequest),
        credential.key,
        doFetch,
      );
      if (!result.ok) return c.json(result.body, result.status);

      const minted = (await result.response.json().catch(() => undefined)) as
        | { client_secret?: { value?: unknown; expires_at?: unknown } }
        | undefined;
      const secret = minted?.client_secret;
      if (!secret || typeof secret.value !== "string" || secret.value === "") {
        return c.json({ error: "The provider's mint response carried no token." }, 502);
      }

      // The ek_ token is upstream text — same suspicion the Gemini name field
      // gets. A value that carries the key is refused, not scrubbed.
      if (scrub(secret.value, credential.key) !== secret.value) {
        return c.json({ error: "The provider's mint response carried a credential where the token belongs." }, 502);
      }

      // Use the upstream's expiry, not the locally-requested one — the
      // provider decides when the secret actually expires, and a locally
      // computed timestamp could outlive it.
      const expiresAt =
        typeof secret.expires_at === "number"
          ? new Date(secret.expires_at * 1000).toISOString()
          : new Date(requestExpiresAt * 1000).toISOString();
      return c.json<MintedToken>({ token: secret.value, expiresAt, model });
    }

    // Gemini Live: the hub mints a constrained ephemeral token via
    // auth_tokens. The session config is locked here — model, voice,
    // instruction, one tool — so a client holding the token connects to
    // exactly this session and cannot reshape it.
    const model = settings.realtimeModel ?? LIVE_MODEL;
    const voice = settings.realtimeVoice ?? LIVE_VOICE;
    const now = Date.now();
    const expiresAt = new Date(now + TOKEN_TTL_MS).toISOString();
    const mintRequest = {
      uses: 1,
      expireTime: expiresAt,
      newSessionExpireTime: new Date(now + NEW_SESSION_WINDOW_MS).toISOString(),
      bidiGenerateContentSetup: buildSetup(model, voice),
    };

    const result = await fetchUpstream(
      AUTH_TOKENS_ENDPOINT,
      { "content-type": "application/json", "x-goog-api-key": credential.key },
      JSON.stringify(mintRequest),
      credential.key,
      doFetch,
    );
    if (!result.ok) return c.json(result.body, result.status);

    const minted = (await result.response.json().catch(() => undefined)) as { name?: unknown } | undefined;
    if (!minted || typeof minted.name !== "string" || minted.name === "") {
      return c.json({ error: "The provider's mint response carried no token." }, 502);
    }

    // The token name is upstream text, and the success path gets the same
    // suspicion the error paths do: a name that carries the key is refused,
    // not scrubbed — a redacted token would dial nothing, and a 200 is the
    // response most likely to be cached somewhere the key must never sit.
    if (scrub(minted.name, credential.key) !== minted.name) {
      return c.json({ error: "The provider's mint response carried a credential where the token belongs." }, 502);
    }

    // Picked fields, never a pass-through: whatever else the upstream echoed
    // stays on this side of the boundary.
    return c.json<MintedToken>({ token: minted.name, expiresAt, model });
  });

  return app;
}
