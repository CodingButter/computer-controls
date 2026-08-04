import { beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_SPEAKER } from "./session-voice.ts";
import {
  type Recording,
  type VoiceTransport,
  createPushToTalk,
  probeVoice,
} from "./push-to-talk.ts";

const RECORDING: Recording = {
  audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
  filetype: "webm",
};
const SPOKEN_REPLY = new Blob([new Uint8Array([0x49, 0x44, 0x33])], {
  type: "audio/mpeg",
});
const DISABLED = "No OpenAI credential. Voice needs an OpenAI account; the chat brain does not.";

type Route = (request: { url: string; init?: RequestInit }) => Response;

const calls: Array<{ url: string; init?: RequestInit }> = [];

function transportServing(routes: Record<string, Route>): VoiceTransport {
  return {
    agentId: "session",
    fetch: (async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      const route = Object.entries(routes).find(([path]) => url.includes(path));
      if (!route) throw new Error(`nothing is mounted at ${url}`);
      return route[1]({ url, init });
    }) as typeof globalThis.fetch,
  };
}

const transcribed = (text: string): Route => () => Response.json({ text });
const synthesized: Route = () =>
  new Response(SPOKEN_REPLY, { headers: { "content-type": "audio/mpeg" } });

function ports(routes: Record<string, Route>, overrides = {}) {
  return {
    transport: transportServing(routes),
    record: async () => RECORDING,
    sendUserTurn: vi.fn(async () => "Your most recent email is from Sam."),
    play: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
});

describe("one press of the talk button", () => {
  it("test_listen_transcript_enters_the_chat_as_a_user_turn: carries a recording to the transcript and the transcript into the chat", async () => {
    const p = ports({
      "/voice/listen": transcribed("read me my most recent email"),
      "/voice/speak": synthesized,
    });

    const result = await createPushToTalk(p).press();

    expect(result).toEqual({
      spoke: true,
      transcript: "read me my most recent email",
      reply: "Your most recent email is from Sam.",
    });
    // The whole point: the transcript arrives as an ordinary user turn,
    // indistinguishable from typing.
    expect(p.sendUserTurn).toHaveBeenCalledWith("read me my most recent email");
    expect(p.play).toHaveBeenCalledWith(SPOKEN_REPLY);
  });

  it("sends the audio as bytes with its container named, not as encoded text", async () => {
    await createPushToTalk(
      ports({
        "/voice/listen": transcribed("hello"),
        "/voice/speak": synthesized,
      }),
    ).press();

    const body = calls[0]!.init!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const audio = body.get("audio") as File;
    expect(audio.name).toBe("audio.webm");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(JSON.parse(body.get("options") as string)).toEqual({
      filetype: "webm",
    });
  });

  it("names the speaker on every reply it asks to be said out loud", async () => {
    await createPushToTalk(
      ports({
        "/voice/listen": transcribed("hello"),
        "/voice/speak": synthesized,
      }),
    ).press();

    const spoke = calls.find((call) => call.url.includes("/voice/speak"))!;
    expect(JSON.parse(spoke.init!.body as string)).toEqual({
      text: "Your most recent email is from Sam.",
      speakerId: VOICE_SPEAKER,
    });
  });

  it("stays silent rather than sending a turn nobody said", async () => {
    const p = ports({ "/voice/listen": transcribed("   ") });

    const result = await createPushToTalk(p).press();

    expect(result).toMatchObject({ spoke: false });
    expect(p.sendUserTurn).not.toHaveBeenCalled();
    expect(calls.some((call) => call.url.includes("/voice/speak"))).toBe(false);
  });

  it("reports the route's own words when transcription fails", async () => {
    const p = ports({
      "/voice/listen": () =>
        Response.json({ error: "Agent does not have voice capabilities" }, { status: 400 }),
    });

    const result = await createPushToTalk(p).press();

    expect(result).toEqual({
      spoke: false,
      reason: "Agent does not have voice capabilities",
    });
    expect(p.sendUserTurn).not.toHaveBeenCalled();
  });

  it("keeps the answer in the conversation even when it cannot be spoken", async () => {
    const p = ports({
      "/voice/listen": transcribed("read me my most recent email"),
      "/voice/speak": () =>
        Response.json({ error: "Failed to generate speech" }, { status: 500 }),
    });

    const result = await createPushToTalk(p).press();

    // The words were already said into the chat; only the audio was lost.
    expect(p.sendUserTurn).toHaveBeenCalledOnce();
    expect(result).toEqual({ spoke: false, reason: "Failed to generate speech" });
    expect(p.play).not.toHaveBeenCalled();
  });

  it("asks the API where it was mounted instead of assuming", async () => {
    const transport = {
      ...transportServing({
        "/voice/listen": transcribed("hello"),
        "/voice/speak": synthesized,
      }),
      apiPrefix: "/mounted/elsewhere",
    };

    await createPushToTalk({ ...ports({}), transport }).press();

    expect(calls[0]!.url).toBe(
      "/mounted/elsewhere/agents/session/voice/listen",
    );
  });
});

describe("whether this session can speak at all", () => {
  it("is available when the agent offers speakers", async () => {
    const transport = transportServing({
      "/voice/speakers": () => Response.json([{ voiceId: "nova" }]),
    });

    await expect(probeVoice(transport, DISABLED)).resolves.toEqual({
      available: true,
      speakers: ["nova"],
    });
  });

  it("is disabled with a reason when the agent has no voice", async () => {
    // An agent with no voice provider answers the speakers route with an empty
    // list rather than an error — this is the calm signal the UI reads.
    const transport = transportServing({
      "/voice/speakers": () => Response.json([]),
    });

    await expect(probeVoice(transport, DISABLED)).resolves.toEqual({
      available: false,
      reason: DISABLED,
    });
  });
});
