import { describe, expect, it } from "vitest";

import {
  OPENAI_REALTIME_ENDPOINT,
  openaiRealtimeProvider,
  type OpenAISocketFactory,
} from "./openai-session.ts";
import type { SocketCloseEvent, SocketLike } from "./session.ts";
import { realtimeConfig, type RealtimeEvents } from "./live.ts";

// A socket the tests own completely, the same pattern session.test.ts uses for
// the Gemini transport. The one difference: the OpenAI factory receives
// protocols (the token rides them), so the fake captures both.
class FakeSocket implements SocketLike {
  url: string;
  protocols: string[];
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(url: string, protocols: string[] = []) {
    this.url = url;
    this.protocols = protocols;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close", {});
  }

  serverCloses(code: number, reason = ""): void {
    this.emit("close", { code, reason, wasClean: code === 1000 });
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener as (event: unknown) => void);
    this.listeners.set(type, existing);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  serverSays(message: object): void {
    this.emit("message", { data: JSON.stringify(message) });
  }
}

function events(overrides: Partial<RealtimeEvents> = {}): RealtimeEvents {
  return {
    onAudio: () => {},
    onTranscript: () => {},
    onFunctionCall: () => {},
    onBargeIn: () => {},
    ...overrides,
  };
}

const MINT_TOKEN = "ek_test-ephemeral-secret";

async function connected(eventHandlers: RealtimeEvents = events()) {
  let socket!: FakeSocket;
  const factory: OpenAISocketFactory = (url, protocols) => {
    socket = new FakeSocket(url, protocols);
    // connect resolves on "open" — the handshake is the WebSocket upgrade,
    // not a server-sent setup frame the way Gemini does it.
    queueMicrotask(() => socket.emit("open", {}));
    return socket;
  };
  const provider = openaiRealtimeProvider(factory);
  const session = await provider.connect(
    realtimeConfig({
      apiKey: "unused-on-this-branch",
      mintToken: async () => MINT_TOKEN,
      model: "gpt-4o-realtime-preview-2024-12-17",
      events: eventHandlers,
    }),
  );
  return { session, socket };
}

describe("connecting to OpenAI Realtime", () => {
  it("carries the ephemeral token in the subprotocol, not the URL", async () => {
    const { socket } = await connected();
    // A token in a URL is a token in every access log. The subprotocol is the
    // browser-safe path — the browser WebSocket API cannot set headers.
    expect(socket.url).not.toContain(MINT_TOKEN);
    expect(socket.protocols).toContain(`openai-insecure-api-key.${MINT_TOKEN}`);
    expect(socket.protocols).toContain("realtime");
    expect(socket.protocols).toContain("openai-beta.realtime-v1");
  });

  it("carries the model in the query string", async () => {
    const { socket } = await connected();
    expect(socket.url).toContain("model=gpt-4o-realtime-preview-2024-12-17");
    expect(socket.url).toBe(
      `${OPENAI_REALTIME_ENDPOINT}?model=${encodeURIComponent("gpt-4o-realtime-preview-2024-12-17")}`,
    );
  });

  it("does not send a session.update — the config is locked server-side in the mint", async () => {
    const { socket } = await connected();
    // Unlike Gemini's setup frame, the OpenAI client sends nothing on connect:
    // the session_config rode the client_secret the hub minted. A client-side
    // restatement would be a second source of truth that could drift.
    expect(socket.sent).toHaveLength(0);
  });
});

describe("OpenAI event mapping", () => {
  it("maps response.audio.delta to onAudio with decoded bytes", async () => {
    const received: Uint8Array[] = [];
    const { socket } = await connected(events({ onAudio: (chunk) => received.push(chunk) }));
    const payload = btoa("hello-audio");
    socket.serverSays({ type: "response.audio.delta", delta: payload });
    expect(received).toHaveLength(1);
    expect(new TextDecoder().decode(received[0])).toBe("hello-audio");
  });

  it("maps assistant and user transcripts to the right speaker", async () => {
    const transcripts: Array<{ text: string; speaker: string }> = [];
    const { socket } = await connected(
      events({ onTranscript: (text, speaker) => transcripts.push({ text, speaker }) }),
    );
    socket.serverSays({ type: "response.audio_transcript.done", transcript: "Hello there." });
    socket.serverSays({ type: "conversation.item.input_audio_transcription.completed", transcript: "Hi." });
    expect(transcripts).toEqual([
      { text: "Hello there.", speaker: "assistant" },
      { text: "Hi.", speaker: "user" },
    ]);
  });

  it("maps response.function_call_arguments.done to onFunctionCall", async () => {
    const calls: Array<{ id: string; name: string; args: object }> = [];
    const { socket } = await connected(
      events({ onFunctionCall: (call) => calls.push({ id: call.id, name: call.name, args: call.args }) }),
    );
    socket.serverSays({
      type: "response.function_call_arguments.done",
      call_id: "call_abc",
      name: "ask_the_hub",
      arguments: JSON.stringify({ request: "check my email" }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      id: "call_abc",
      name: "ask_the_hub",
      args: { request: "check my email" },
    });
  });

  it("maps input_audio_buffer.speech_started to onBargeIn", async () => {
    let barged = false;
    const { socket } = await connected(events({ onBargeIn: () => (barged = true) }));
    socket.serverSays({ type: "input_audio_buffer.speech_started" });
    expect(barged).toBe(true);
  });
});

describe("OpenAI wire shapes", () => {
  it("starts muted so idle audio never leaves the machine", async () => {
    const { session, socket } = await connected();
    expect(session.muted).toBe(true);
    // While muted, audio is dropped before it hits the wire.
    session.sendAudio(new TextEncoder().encode("audio-1"));
    expect(socket.sent).toHaveLength(0);
  });

  it("sends input_audio_buffer.append once unmuted", async () => {
    const { session, socket } = await connected();
    session.unmute();
    expect(session.muted).toBe(false);
    session.sendAudio(new TextEncoder().encode("audio-2"));
    expect(socket.sent).toHaveLength(1);
    const frame = JSON.parse(socket.sent[0]);
    expect(frame.type).toBe("input_audio_buffer.append");
    expect(frame.audio).toBe(btoa("audio-2"));
  });

  it("sends a conversation item and response.create for text", async () => {
    const { session, socket } = await connected();
    session.unmute();
    await session.sendText("What's the weather?");
    expect(socket.sent).toHaveLength(2);
    const item = JSON.parse(socket.sent[0]);
    expect(item.type).toBe("conversation.item.create");
    expect(item.item.role).toBe("user");
    expect(item.item.content[0].text).toBe("What's the weather?");
    expect(JSON.parse(socket.sent[1]).type).toBe("response.create");
  });

  it("sends a function_call_output with the call_id for function results", async () => {
    const { session, socket } = await connected();
    session.unmute();
    await session.sendFunctionResult("call_abc", '{"result": "all clear"}');
    expect(socket.sent).toHaveLength(1);
    const frame = JSON.parse(socket.sent[0]);
    expect(frame.type).toBe("conversation.item.create");
    expect(frame.item.type).toBe("function_call_output");
    expect(frame.item.call_id).toBe("call_abc");
    expect(frame.item.output).toBe('{"result": "all clear"}');
  });
});

describe("OpenAI refusal classification", () => {
  it("rejects connect when the server closes during setup with a model refusal", async () => {
    let socket!: FakeSocket;
    const provider = openaiRealtimeProvider((url, protocols) => {
      socket = new FakeSocket(url, protocols);
      queueMicrotask(() => {
        // The server rejects the upgrade — close fires before open, the way a
        // policy rejection during the WebSocket handshake would.
        socket.serverCloses(1008, "model not found");
      });
      return socket;
    });
    await expect(
      provider.connect(
        realtimeConfig({
          apiKey: "unused",
          mintToken: async () => MINT_TOKEN,
          model: "gpt-bogus-model",
          events: events(),
        }),
      ),
    ).rejects.toThrow(/refused the model/);
  });

  it("fires onRefusal and stops redialing when the server drops mid-session with a model refusal", async () => {
    let socket!: FakeSocket;
    const provider = openaiRealtimeProvider((url, protocols) => {
      socket = new FakeSocket(url, protocols);
      queueMicrotask(() => socket.emit("open", {}));
      return socket;
    });
    const refusals: string[] = [];
    const session = await provider.connect(
      realtimeConfig({
        apiKey: "unused",
        mintToken: async () => MINT_TOKEN,
        model: "gpt-deprecated",
        events: events({ onRefusal: (reason) => refusals.push(reason) }),
      }),
    );
    // Server drops mid-session with a permanent refusal code.
    socket.serverCloses(4004, "model deprecated");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("refused the model");
    expect(refusals[0]).toContain("gpt-deprecated");
    // The session is closed by us — no redial.
    expect(session.connected).toBe(false);
    await session.close();
  });
});
