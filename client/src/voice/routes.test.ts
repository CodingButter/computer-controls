import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { CompositeVoice } from "@mastra/core/voice";

import { resolveVoiceCredential, isRefusal } from "./credentials.ts";
import { createSessionVoice } from "./session-voice.ts";
import { buildVoiceApp, SESSION_AGENT_ID } from "./routes.ts";

const BASE = `/api/agents/${SESSION_AGENT_ID}/voice`;

/**
 * The route tests care about the hub's half of the conversation: what a
 * request becomes before the voice provider sees it, and what an answer
 * becomes on the way back out. The provider itself is a stub here; the real
 * one is exercised in session-voice.test.ts at the wire.
 */
function stubVoice() {
  return {
    getSpeakers: vi.fn(async () => [{ voiceId: "nova" }]),
    listen: vi.fn(async (_audio: unknown, options: { filetype?: string }) => {
      void options;
      return "read me my most recent email";
    }),
    speak: vi.fn(async () => Readable.from(Buffer.from("mp3-bytes"))),
  };
}

/**
 * A provider that is mounted and then refuses. This is the shape the credential
 * proof recorded on a real machine: the token authenticated, the wallet was
 * empty, and OpenAI's client threw an error carrying a status.
 */
function refusingVoice(error: unknown) {
  const throwing = async () => {
    throw error;
  };
  return { getSpeakers: vi.fn(throwing), listen: vi.fn(throwing), speak: vi.fn(throwing) };
}

function providerError(message: string, status?: number) {
  const error = new Error(message) as Error & { status?: number };
  if (status !== undefined) error.status = status;
  return error;
}

/** Verbatim from docs/proofs/which-credential-the-voice-lane-accepts.md. */
const BILLING_REFUSAL =
  "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.";

function speakRequest(app: ReturnType<typeof buildVoiceApp>) {
  return app.request(`${BASE}/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Your most recent email is from Sam." }),
  });
}

function listenRequest(app: ReturnType<typeof buildVoiceApp>) {
  const form = new FormData();
  form.set("audio", new File([Buffer.from("webm-bytes")], "audio.webm"));
  form.set("options", JSON.stringify({ filetype: "webm" }));
  return app.request(`${BASE}/listen`, { method: "POST", body: form });
}

describe("the voice routes the hub serves", () => {
  it("test_voice_is_disabled_without_an_openai_credential: refuses with the reason, while the probe stays calm", async () => {
    // The store knows only an Anthropic sign-in; the chat brain is fine, the
    // voice lane is not, and the refusal must say so without inventing drama.
    const resolved = await resolveVoiceCredential({
      get: (provider: string) =>
        provider === "anthropic"
          ? { type: "oauth" as const, access: "a", refresh: "r", expires: 0 }
          : undefined,
      getStoredApiKey: () => undefined,
      getApiKey: async () => undefined,
    });
    expect(isRefusal(resolved)).toBe(true);
    const reason = isRefusal(resolved) ? resolved.reason : "";
    expect(createSessionVoice(resolved)).toBeUndefined();

    const app = buildVoiceApp({ reason });

    // The probe route answers calmly: an empty list, not an error page.
    const speakers = await app.request(`${BASE}/speakers`);
    expect(speakers.status).toBe(200);
    expect(await speakers.json()).toEqual([]);

    // The working routes refuse loudly, naming what is missing.
    const speak = await app.request(`${BASE}/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(speak.status).toBe(400);
    expect(((await speak.json()) as { error: string }).error).toMatch(/OpenAI/);

    const listen = await app.request(`${BASE}/listen`, { method: "POST" });
    expect(listen.status).toBe(400);
    expect(((await listen.json()) as { error: string }).error).toMatch(/OpenAI/);
  });

  it("turns a speak request into audio bytes with the named speaker", async () => {
    const voice = stubVoice();
    const app = buildVoiceApp({ voice: voice as unknown as CompositeVoice });

    const res = await app.request(`${BASE}/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Your most recent email is from Sam.", speakerId: "nova" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("mp3-bytes");
    expect(voice.speak).toHaveBeenCalledWith("Your most recent email is from Sam.", {
      speaker: "nova",
    });
  });

  it("hands a recording to the ear with its container named", async () => {
    const voice = stubVoice();
    const app = buildVoiceApp({ voice: voice as unknown as CompositeVoice });

    const form = new FormData();
    form.set("audio", new File([Buffer.from("webm-bytes")], "audio.webm"));
    form.set("options", JSON.stringify({ filetype: "webm" }));

    const res = await app.request(`${BASE}/listen`, { method: "POST", body: form });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "read me my most recent email" });
    expect(voice.listen).toHaveBeenCalledTimes(1);
    expect(voice.listen.mock.calls[0]![1]).toEqual({ filetype: "webm" });
  });

  it("refuses an empty speak turn before the provider is asked", async () => {
    const voice = stubVoice();
    const app = buildVoiceApp({ voice: voice as unknown as CompositeVoice });

    const res = await app.request(`${BASE}/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });

    expect(res.status).toBe(400);
    expect(voice.speak).not.toHaveBeenCalled();
  });

  it("test_a_provider_refusal_comes_back_as_json_not_a_500: the wallet is empty and the caller is told so", async () => {
    // Everything before this point worked: the credential resolved, the voice
    // mounted, health said enabled. The refusal happens on the wire, and it is
    // the only thing standing between a person and an explanation.
    const voice = refusingVoice(providerError(BILLING_REFUSAL, 429));
    const app = buildVoiceApp({ voice: voice as unknown as CompositeVoice });

    for (const res of [await speakRequest(app), await listenRequest(app)]) {
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(429);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/credits/);
      expect(body.error).not.toMatch(/Internal Server Error/);
    }

    // The probe answers an empty provider calmly and a refusing one honestly;
    // either way the UI gets JSON rather than an error page to parse.
    const speakers = await app.request(`${BASE}/speakers`);
    expect(speakers.status).toBe(429);
    expect(((await speakers.json()) as { error: string }).error).toMatch(/credits/);
  });

  it("test_the_refusal_reason_is_sanitized_before_it_leaves: the provider's words, not its secrets", async () => {
    const SECRET = "sk-liveDEADBEEF0123456789";
    const cases = [
      // Credential-shaped: dropped entirely, however useful it looked.
      providerError(`Incorrect API key provided: ${SECRET}`, 401),
      // The offending part is below the fold; only the first line survives.
      providerError(`Request failed\nAuthorization: Bearer ${SECRET}`, 400),
      // Longer than anyone reads, and long enough to hide things in.
      providerError(`${"Retry later. ".repeat(40)}${SECRET}`, 503),
    ];

    for (const error of cases) {
      const app = buildVoiceApp({ voice: refusingVoice(error) as unknown as CompositeVoice });
      const res = await speakRequest(app);
      const seen = JSON.stringify({
        status: res.status,
        headers: [...res.headers],
        body: await res.text(),
      });
      expect(seen).not.toContain(SECRET);
      expect(seen).not.toContain("Bearer");
    }

    // Sanitizing is not silencing: a refusal a person can act on gets through
    // intact, which is the whole reason for relaying it at all.
    const plain = buildVoiceApp({
      voice: refusingVoice(providerError(BILLING_REFUSAL, 429)) as unknown as CompositeVoice,
    });
    expect(((await (await speakRequest(plain)).json()) as { error: string }).error).toBe(
      BILLING_REFUSAL,
    );
  });

  it("test_a_transport_failure_and_a_billing_refusal_are_both_answers: with the status each deserves", async () => {
    // No status, because the request never got far enough to be refused.
    const dropped = buildVoiceApp({
      voice: refusingVoice(new TypeError("fetch failed")) as unknown as CompositeVoice,
    });
    const transport = await speakRequest(dropped);
    expect(transport.status).toBe(502);
    expect(((await transport.json()) as { error: string }).error).toBeTruthy();

    // A status, because OpenAI answered — it just answered no.
    const dry = buildVoiceApp({
      voice: refusingVoice(providerError(BILLING_REFUSAL, 429)) as unknown as CompositeVoice,
    });
    const refused = await speakRequest(dry);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toMatch(/credits/);

    // Something thrown that is not an error at all still leaves as an answer.
    const strange = buildVoiceApp({
      voice: refusingVoice("something the client threw") as unknown as CompositeVoice,
    });
    const odd = await speakRequest(strange);
    expect(odd.status).toBe(502);
    expect(odd.headers.get("content-type")).toMatch(/application\/json/);
  });
});
