import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_TOKENS_ENDPOINT,
  NEW_SESSION_WINDOW_MS,
  OPENAI_CLIENT_SECRETS_ENDPOINT,
  OPENAI_TOKEN_TTL_S,
  TOKEN_MINT_PATH,
  TOKEN_TTL_MS,
  buildTokenMintApp,
} from "./token-mint.ts";
import { LIVE_MODEL, LIVE_VOICE } from "../live/live.ts";
import { ORB_SYSTEM_INSTRUCTION } from "../live/session.ts";

const STORED_KEY = "AIzaSyFAKE-b1gbeast-key-that-must-never-travel";

/** The sentence the status route speaks; the mint must speak the same one. */
const NO_GOOGLE_ACCOUNT =
  "The orb needs a Google account. The chat brain does not — it keeps using " +
  "whatever model you signed in with, and typing still works. Paste a Google " +
  "API key, or sign in to Google, to turn the orb on.";

function keyedStore() {
  return {
    get: () => undefined,
    getStoredApiKey: (provider: string) => (provider === "google" ? STORED_KEY : undefined),
    getApiKey: async () => undefined,
  };
}

function keylessStore() {
  return {
    get: () => undefined,
    getStoredApiKey: () => undefined,
    getApiKey: async () => undefined,
  };
}

function mintOk(name = "auth_tokens/minted-token-1") {
  return vi.fn(async () => new Response(JSON.stringify({ name }), { status: 200 }));
}

const OPENAI_KEY = "sk-fake-openai-key-that-must-never-travel";

const NO_OPENAI_ACCOUNT =
  "The orb needs an OpenAI account. The chat brain does not — it keeps using " +
  "whatever model you signed in with, and typing still works. Sign in to " +
  "OpenAI, or paste an OpenAI API key, to turn the orb on.";

/** A store that has only an OpenAI key, filed under the openai-codex slot. */
function openaiStore() {
  return {
    get: () => undefined,
    getStoredApiKey: (provider: string) => (provider === "openai-codex" ? OPENAI_KEY : undefined),
    getApiKey: async () => undefined,
  };
}

function openaiMintOk(value = "ek_test-minted-secret-1", expiresAtSec?: number) {
  const exp = expiresAtSec ?? Math.floor(Date.now() / 1000) + 60;
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ client_secret: { value, expires_at: exp } }), { status: 200 }),
  );
}

async function openaiSettings(dir: string, extra: Record<string, string> = {}) {
  const settingsPath = path.join(dir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ realtimeProvider: "openai", ...extra }));
  return settingsPath;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "comcon-mint-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the token mint", () => {
  it("locks the outgoing mint to the configured model, both tools, both transcriptions", async () => {
    const settingsPath = path.join(dir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ realtimeModel: "gemini-2.5-flash-native-audio-latest" }));
    const fetchFn = mintOk();
    const app = buildTokenMintApp({ credentials: keyedStore(), settingsPath, fetchFn });

    const res = await app.request(TOKEN_MINT_PATH, { method: "POST" });
    expect(res.status).toBe(200);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(AUTH_TOKENS_ENDPOINT);
    // The key rides a header, never the URL — a token in a URL is a token in
    // every access log.
    expect(url).not.toContain(STORED_KEY);
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(STORED_KEY);

    const body = JSON.parse(init.body as string) as {
      uses: number;
      expireTime: string;
      newSessionExpireTime: string;
      bidiGenerateContentSetup: {
        model: string;
        systemInstruction: { parts: [{ text: string }] };
        tools: [{ functionDeclarations: { name: string }[] }];
        inputAudioTranscription: object;
        outputAudioTranscription: object;
        generationConfig: { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } } };
      };
    };
    expect(body.uses).toBe(1);
    expect(body.bidiGenerateContentSetup.model).toBe("models/gemini-2.5-flash-native-audio-latest");
    expect(body.bidiGenerateContentSetup.tools).toHaveLength(1);
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations).toHaveLength(2);
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[0].name).toBe("ask_the_hub");
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[1].name).toBe("stop_listening");
    expect(body.bidiGenerateContentSetup.inputAudioTranscription).toEqual({});
    expect(body.bidiGenerateContentSetup.outputAudioTranscription).toEqual({});
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain("ask_the_hub");
    expect(
      (body.bidiGenerateContentSetup as unknown as { generationConfig: { responseModalities: string[] } })
        .generationConfig.responseModalities,
    ).toEqual(["AUDIO"]);
    // The clocks are security properties, not preferences: the magnitudes are
    // pinned to the exported constants, so quietly widening either window
    // turns this red. Ordering alone would stay green at any laxity.
    const now = Date.now();
    expect(Date.parse(body.expireTime) - now).toBeGreaterThan(TOKEN_TTL_MS - 10_000);
    expect(Date.parse(body.expireTime) - now).toBeLessThanOrEqual(TOKEN_TTL_MS);
    expect(Date.parse(body.newSessionExpireTime) - now).toBeGreaterThan(NEW_SESSION_WINDOW_MS - 10_000);
    expect(Date.parse(body.newSessionExpireTime) - now).toBeLessThanOrEqual(NEW_SESSION_WINDOW_MS);
    // And the windows themselves stay sane: a session-start window measured
    // in minutes or a token lifetime measured in hours is a policy change,
    // not a refactor.
    expect(NEW_SESSION_WINDOW_MS).toBeLessThanOrEqual(60_000);
    expect(TOKEN_TTL_MS).toBeLessThanOrEqual(30 * 60_000);
  });

  it("refuses a mint response that carries the key where the token belongs", async () => {
    // The success path gets the same suspicion the error paths do: a 200 body
    // is the response most likely to be cached, so an upstream that echoes
    // the credential in the token's name is refused, never relayed.
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ name: `auth_tokens/${STORED_KEY}` }), { status: 200 }),
    );
    const app = buildTokenMintApp({ credentials: keyedStore(), fetchFn });
    const res = await app.request(TOKEN_MINT_PATH, { method: "POST" });
    expect(res.status).toBe(502);
    const serialized = await res.text();
    expect(serialized).not.toContain(STORED_KEY);
    expect(serialized).toContain("carried a credential");
  });

  it("falls back to the pinned model and voice when nothing is configured", async () => {
    const fetchFn = mintOk();
    const app = buildTokenMintApp({ credentials: keyedStore(), fetchFn });
    const res = await app.request(TOKEN_MINT_PATH, { method: "POST" });
    expect(res.status).toBe(200);
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as {
      bidiGenerateContentSetup: { model: string; generationConfig: { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } } } };
    };
    expect(body.bidiGenerateContentSetup.model).toBe(`models/${LIVE_MODEL}`);
    expect(body.bidiGenerateContentSetup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(LIVE_VOICE);
  });

  it("refuses a caller trying to shape the mint, before touching the credential or the network", async () => {
    const fetchFn = mintOk();
    const credentials = keyedStore();
    const spy = vi.spyOn(credentials, "getStoredApiKey");
    const app = buildTokenMintApp({ credentials, fetchFn });

    for (const shaped of [
      JSON.stringify({ model: "models/gemini-attacker-pro" }),
      JSON.stringify({ tools: [] }),
      JSON.stringify({ liveConnectConstraints: {} }),
      "anything at all",
    ]) {
      const res = await app.request(TOKEN_MINT_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: shaped,
      });
      expect(res.status).toBe(400);
    }
    // No mint attempt, no credential resolution: the documented
    // ephemeral-token injection class dies at the door.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it("speaks the product's one credential sentence when there is no Google account", async () => {
    const fetchFn = mintOk();
    const app = buildTokenMintApp({ credentials: keylessStore(), fetchFn });
    const res = await app.request(TOKEN_MINT_PATH, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(NO_GOOGLE_ACCOUNT);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("passes an upstream refusal through verbatim, minus the key", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(`API key not valid: ${STORED_KEY}. Please pass a valid key.`, {
          status: 400,
          statusText: "Bad Request",
        }),
    );
    const app = buildTokenMintApp({ credentials: keyedStore(), fetchFn });
    const res = await app.request(TOKEN_MINT_PATH, { method: "POST" });
    expect(res.status).toBe(502);
    const error = ((await res.json()) as { error: string }).error;
    expect(error).toContain("API key not valid");
    expect(error).toContain("[redacted]");
    expect(error).not.toContain(STORED_KEY);
  });

  it("never returns the stored key, even when the upstream echoes it", async () => {
    // A hostile-or-buggy upstream that reflects the credential back in extra
    // fields. The response is picked fields, not a pass-through.
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ name: "auth_tokens/minted-token-2", echoedKey: STORED_KEY, debug: { key: STORED_KEY } }),
          { status: 200 },
        ),
    );
    const app = buildTokenMintApp({ credentials: keyedStore(), fetchFn });
    const res = await app.request(TOKEN_MINT_PATH, { method: "POST" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(STORED_KEY);
    const body = JSON.parse(text) as { token: string; expiresAt: string; model: string };
    expect(body).toEqual({
      token: "auth_tokens/minted-token-2",
      expiresAt: expect.stringMatching(/^\d{4}-/) as unknown,
      model: LIVE_MODEL,
    });
  });

  it("a mint response with no token is a named failure, not an empty success", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const app = buildTokenMintApp({ credentials: keyedStore(), fetchFn });
    const res = await app.request(TOKEN_MINT_PATH, { method: "POST" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("no token");
  });

  it("a network failure names itself without leaking the key", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error(`connect ETIMEDOUT while sending ${STORED_KEY}`);
    });
    const app = buildTokenMintApp({ credentials: keyedStore(), fetchFn });
    const res = await app.request(TOKEN_MINT_PATH, { method: "POST" });
    expect(res.status).toBe(502);
    const error = ((await res.json()) as { error: string }).error;
    expect(error).toContain("ETIMEDOUT");
    expect(error).not.toContain(STORED_KEY);
  });
});

describe("the OpenAI token mint", () => {
  it("locks the outgoing mint to the session config, one flat tool, via client_secrets", async () => {
    const settingsPath = await openaiSettings(dir, {
      realtimeModel: "gpt-4o-realtime-preview-2024-12-17",
      realtimeVoice: "alloy",
    });
    const fetchFn = openaiMintOk();
    const app = buildTokenMintApp({ credentials: openaiStore(), settingsPath, fetchFn });

    const res = await app.request(TOKEN_MINT_PATH, { method: "POST" });
    expect(res.status).toBe(200);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENAI_CLIENT_SECRETS_ENDPOINT);
    // The key rides the Authorization header, never the URL.
    expect(url).not.toContain(OPENAI_KEY);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${OPENAI_KEY}`);

    const body = JSON.parse(init.body as string) as {
      expires_at: number;
      session_config: {
        model: string;
        voice: string;
        instructions: string;
        tools: [{ type: string; name: string; parameters: object }];
        tool_choice: string;
        input_audio_format: string;
        output_audio_format: string;
        input_audio_transcription: { model: string };
        output_audio_transcription: { model: string };
      };
    };
    expect(body.session_config.model).toBe("gpt-4o-realtime-preview-2024-12-17");
    expect(body.session_config.voice).toBe("alloy");
    expect(body.session_config.instructions).toBe(ORB_SYSTEM_INSTRUCTION);
    expect(body.session_config.tools).toHaveLength(1);
    expect(body.session_config.tools[0].type).toBe("function");
    expect(body.session_config.tools[0].name).toBe("ask_the_hub");
    expect(body.session_config.tool_choice).toBe("auto");
    expect(body.session_config.input_audio_format).toBe("pcm16");
    expect(body.session_config.output_audio_format).toBe("pcm16");
    // The requested expiry is tight — the browser dials immediately after mint.
    const now = Math.floor(Date.now() / 1000);
    expect(body.expires_at - now).toBeGreaterThan(OPENAI_TOKEN_TTL_S - 10);
    expect(body.expires_at - now).toBeLessThanOrEqual(OPENAI_TOKEN_TTL_S);
  });

  it("refuses a mint response that carries the key where the token belongs", async () => {
    // Same suspicion the Gemini name field gets: a client_secret value that
    // echoes the credential is refused, never relayed.
    const settingsPath = await openaiSettings(dir);
    const fetchFn = openaiMintOk(`ek_${OPENAI_KEY}`);
    const app = buildTokenMintApp({ credentials: openaiStore(), settingsPath, fetchFn });

    const res = await app.request(TOKEN_MINT_PATH, { method: "POST" });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(OPENAI_KEY);
    expect(text).toContain("carried a credential");
  });

  it("never returns the stored key, even when the upstream echoes it", async () => {
    // A hostile upstream that reflects the credential back in extra fields.
    const settingsPath = await openaiSettings(dir);
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            client_secret: { value: "ek_clean-secret-2", expires_at: Math.floor(Date.now() / 1000) + 60 },
            echoedKey: OPENAI_KEY,
            debug: { key: OPENAI_KEY },
          }),
          { status: 200 },
        ),
    );
    const app = buildTokenMintApp({ credentials: openaiStore(), settingsPath, fetchFn });

    const res = await app.request(TOKEN_MINT_PATH, { method: "POST" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(OPENAI_KEY);
    const parsed = JSON.parse(text) as { token: string; expiresAt: string; model: string };
    expect(parsed.token).toBe("ek_clean-secret-2");
    expect(parsed.expiresAt).toMatch(/^\d{4}-/);
  });

  it("uses the upstream's expiry, not the locally-requested one", async () => {
    // The provider decides when the secret actually expires; a locally computed
    // timestamp could outlive it.
    const settingsPath = await openaiSettings(dir);
    const upstreamExpiry = Math.floor(Date.now() / 1000) + 30;
    const fetchFn = openaiMintOk("ek_upstream-expiry-3", upstreamExpiry);
    const app = buildTokenMintApp({ credentials: openaiStore(), settingsPath, fetchFn });

    const res = await app.request(TOKEN_MINT_PATH, { method: "POST" });
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { expiresAt: string };
    expect(parsed.expiresAt).toBe(new Date(upstreamExpiry * 1000).toISOString());
  });

  it("speaks the product's one credential sentence when there is no OpenAI account", async () => {
    const settingsPath = await openaiSettings(dir);
    const fetchFn = openaiMintOk();
    const app = buildTokenMintApp({ credentials: keylessStore(), settingsPath, fetchFn });

    const res = await app.request(TOKEN_MINT_PATH, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(NO_OPENAI_ACCOUNT);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
