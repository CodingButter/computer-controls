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
});
