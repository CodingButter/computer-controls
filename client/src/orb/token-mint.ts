/**
 * The hub mints a constrained ephemeral token, and the key stays home.
 *
 * A client-side mouth needs to dial Google directly — that is the whole point
 * of the migration, every relayed audio frame crosses the network twice — but
 * the stored Google credential must never reach a device. So the hub trades
 * it, on request, for a v1alpha ephemeral token whose constraints are decided
 * here, server-side, and nowhere else: the configured live model, the orb's
 * system instruction, exactly one tool, single use, and clocks tight enough
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

import { isRefusal, resolveOrbCredential } from "./credentials.ts";
import { ORB_SYSTEM_INSTRUCTION } from "../live/session.ts";
import { HUB_FUNCTION_DECLARATION, LIVE_MODEL, LIVE_VOICE } from "../live/live.ts";
import { readRealtimeSettings } from "./realtime-settings.ts";

export const TOKEN_MINT_PATH = "/api/orb/token";

/** Where ephemeral tokens are minted. The key rides a header, never the URL. */
export const AUTH_TOKENS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1alpha/auth_tokens";

/** The window in which the minted token may start a session. */
export const NEW_SESSION_WINDOW_MS = 60_000;

/** The token's own lifetime. Enforced at connect, not mid-session. */
export const TOKEN_TTL_MS = 30 * 60_000;

export type MintedToken = {
  token: string;
  expiresAt: string;
  model: string;
};

export type TokenMintOptions = {
  credentials: Parameters<typeof resolveOrbCredential>[0];
  /** Absent means the pinned defaults, the same fallback the orb boot uses. */
  settingsPath?: string;
  /** Injectable so tests assert on the outgoing mint request. */
  fetchFn?: typeof fetch;
};

/**
 * The setup the token is locked to — field-for-field the same
 * BidiGenerateContentSetup frame live-gemini.ts builds for the hub's own
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
    tools: [{ functionDeclarations: [HUB_FUNCTION_DECLARATION] }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
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

    const credential = await resolveOrbCredential(options.credentials);
    if (isRefusal(credential)) {
      // The product's one credential vocabulary — the same sentence the
      // status route speaks, so a page never has to translate.
      return c.json({ error: credential.reason }, 409);
    }

    // Read per-request, deliberately fresher than the hub's own boot-time
    // read: a token minted after a settings change reflects the new choice.
    const settings = options.settingsPath ? await readRealtimeSettings(options.settingsPath) : {};
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

    let upstream: Response;
    try {
      upstream = await doFetch(AUTH_TOKENS_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": credential.key,
        },
        body: JSON.stringify(mintRequest),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return c.json({ error: scrub(`The token mint could not be reached: ${reason}`, credential.key) }, 502);
    }

    if (!upstream.ok) {
      // The refusal names its reason — the upstream's words, minus the one
      // word that is nobody's business.
      const text = await upstream.text().catch(() => "");
      return c.json(
        { error: scrub(`The provider refused to mint a token: ${text || upstream.statusText}`, credential.key) },
        502,
      );
    }

    const minted = (await upstream.json().catch(() => undefined)) as { name?: unknown } | undefined;
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
