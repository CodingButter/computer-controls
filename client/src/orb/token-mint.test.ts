import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_TOKENS_ENDPOINT,
  TOKEN_MINT_PATH,
  buildTokenMintApp,
} from "./token-mint.ts";
import { LIVE_MODEL, LIVE_VOICE } from "./live.ts";

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

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "comcon-mint-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the token mint", () => {
  it("locks the outgoing mint to the configured model, one tool, both transcriptions", async () => {
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
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations).toHaveLength(1);
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[0].name).toBe("ask_the_hub");
    expect(body.bidiGenerateContentSetup.inputAudioTranscription).toEqual({});
    expect(body.bidiGenerateContentSetup.outputAudioTranscription).toEqual({});
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain("ask_the_hub");
    // The session-start window is minutes tighter than the token's own life.
    expect(Date.parse(body.newSessionExpireTime)).toBeLessThan(Date.parse(body.expireTime));
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
