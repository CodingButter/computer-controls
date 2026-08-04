import { Readable } from "node:stream";
import { Agent } from "@mastra/core/agent";
import { CompositeVoice } from "@mastra/core/voice";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LISTENING_MODEL,
  SPEECH_MODEL,
  VOICE_SPEAKER,
  createSessionVoice,
} from "./session-voice.ts";

const SYNTHESIZED_MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0xff]);
const HEARD = "read me my most recent email";

type Sent = { url: string; body: Record<string, unknown> };

const sent: Sent[] = [];

/**
 * Stands in for OpenAI at the wire, not at the module boundary: `OpenAIVoice`
 * builds its client inside its own constructor, so a module mock of `openai`
 * lands too late and the request goes out to the real API. Injecting `fetch`
 * is the only seam that actually holds the call back.
 */
const openaiAtTheWire: typeof globalThis.fetch = async (input, init) => {
  const url = String(input);
  const raw = init?.body;
  const body =
    raw instanceof FormData
      ? Object.fromEntries(raw.entries())
      : JSON.parse(String(raw));
  sent.push({ url, body });

  if (url.includes("/audio/speech")) {
    return new Response(SYNTHESIZED_MP3, {
      headers: { "content-type": "audio/mpeg" },
    });
  }
  return Response.json({ text: HEARD });
};

const OPENAI_CREDENTIAL = { kind: "api-key" as const, key: "sk-test" };
const NO_OPENAI_CREDENTIAL = { reason: "no OpenAI account is connected" };

const sessionVoice = (credential: Parameters<typeof createSessionVoice>[0]) =>
  createSessionVoice(credential, { fetch: openaiAtTheWire });

/** What the speak route does with the stream the provider hands back. */
async function collect(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as Readable) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function agentWithVoice(voice: CompositeVoice | undefined) {
  return new Agent({
    id: "session",
    name: "session",
    instructions: "the session agent",
    model: "anthropic/claude-sonnet-4-5",
    ...(voice ? { voice } : {}),
  });
}

beforeEach(() => {
  sent.length = 0;
});

describe("the voice a session agent gets", () => {
  it("hands the ear and the mouth to CompositeVoice separately", () => {
    const voice = sessionVoice(OPENAI_CREDENTIAL);

    expect(voice).toBeInstanceOf(CompositeVoice);
    // Guards the one cast in session-voice.ts: if the two bundled copies of
    // MastraVoice ever diverge for real, these stop being wired up.
    expect(voice).toMatchObject({
      speakProvider: expect.anything(),
      listenProvider: expect.anything(),
      realtimeProvider: undefined,
    });
  });

  it("turns agent text into audio bytes, the way the speak route does", async () => {
    const agent = agentWithVoice(sessionVoice(OPENAI_CREDENTIAL));

    const voice = await agent.getVoice();
    const audio = await voice.speak("Your most recent email is from Sam.", {
      speaker: VOICE_SPEAKER,
    });

    expect(await collect(audio as NodeJS.ReadableStream)).toEqual(SYNTHESIZED_MP3);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({
      model: SPEECH_MODEL,
      input: "Your most recent email is from Sam.",
      response_format: "mp3",
    });
  });

  it("says every word in the voice we picked, never the provider's default", async () => {
    const voice = sessionVoice(OPENAI_CREDENTIAL)!;

    await voice.speak("speaker left to the assembly");
    await voice.speak("speaker named by the caller", { speaker: VOICE_SPEAKER });

    expect(sent.map((call) => call.body.voice)).toEqual([
      VOICE_SPEAKER,
      VOICE_SPEAKER,
    ]);
    // "alloy" is what OpenAIVoice falls back to when nobody chose. Nobody
    // choosing is the failure this asserts against: a voice is an identity,
    // and it must not change because a package published a new default.
    expect(sent.map((call) => call.body.voice)).not.toContain("alloy");
  });

  it("transcribes a recording with whisper, keeping the recorded filetype", async () => {
    const voice = sessionVoice(OPENAI_CREDENTIAL)!;

    const heard = await voice.listen(Readable.from([Buffer.from("webm-bytes")]), {
      filetype: "webm",
    });

    expect(heard).toBe(HEARD);
    expect(sent[0]!.url).toContain("/audio/transcriptions");
    expect(sent[0]!.body.model).toBe(LISTENING_MODEL);
    expect((sent[0]!.body.file as File).name).toBe("audio.webm");
  });

  it("does not let the voice provider choose the model that thinks", async () => {
    const speaking = agentWithVoice(sessionVoice(OPENAI_CREDENTIAL));
    const silent = agentWithVoice(undefined);

    const speakingModel = await speaking.getModel();
    const silentModel = await silent.getModel();

    expect(speakingModel.modelId).toBe(silentModel.modelId);
    expect(speakingModel.modelId).toBe("claude-sonnet-4-5");
    expect(speakingModel.modelId).not.toMatch(/gpt|tts|whisper/);
  });

  it("gives an agent no voice at all when there is no OpenAI credential", async () => {
    expect(sessionVoice(NO_OPENAI_CREDENTIAL)).toBeUndefined();

    const agent = agentWithVoice(sessionVoice(NO_OPENAI_CREDENTIAL));
    const voice = await agent.getVoice();

    await expect(voice.speak("anything")).rejects.toMatchObject({
      id: "VOICE_DEFAULT_NO_SPEAK_PROVIDER",
      message: "No voice provider configured",
      domain: "MASTRA_VOICE",
    });
    expect(sent).toHaveLength(0);
  });
});
