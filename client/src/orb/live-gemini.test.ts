import { describe, expect, it } from "vitest";

import {
  LIVE_ENDPOINT,
  ORB_SYSTEM_INSTRUCTION,
  geminiLiveProvider,
  type SocketLike,
} from "./live-gemini.ts";
import { HUB_FUNCTION_NAME, realtimeConfig, type RealtimeEvents } from "./live.ts";

// A socket the tests own completely: every frame sent is recorded, and the
// test plays the server by emitting message events.
class FakeSocket implements SocketLike {
  url: string;
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close", {});
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

async function connected(eventHandlers: RealtimeEvents = events()) {
  let socket!: FakeSocket;
  const provider = geminiLiveProvider((url) => {
    socket = new FakeSocket(url);
    // The open + setupComplete handshake runs on the microtask queue after
    // connect() subscribes, the way a real socket opens after construction.
    queueMicrotask(() => {
      socket.emit("open", {});
      socket.serverSays({ setupComplete: {} });
    });
    return socket;
  });
  const session = await provider.connect(
    realtimeConfig({ apiKey: "test-key", events: eventHandlers }),
  );
  return { session, socket };
}

describe("connecting to Gemini Live", () => {
  it("carries the key in the endpoint url", async () => {
    const { socket } = await connected();
    expect(socket.url).toBe(`${LIVE_ENDPOINT}?key=test-key`);
  });

  it("sends setup as the first frame, with the model, the one tool, and both transcriptions", async () => {
    const { socket } = await connected();
    const first = JSON.parse(socket.sent[0]);
    expect(first.setup.model).toMatch(/^models\//);
    expect(first.setup.tools).toHaveLength(1);
    const declarations = first.setup.tools[0].functionDeclarations;
    expect(declarations).toHaveLength(1);
    expect(declarations[0].name).toBe(HUB_FUNCTION_NAME);
    expect(first.setup.inputAudioTranscription).toEqual({});
    expect(first.setup.outputAudioTranscription).toEqual({});
    expect(first.setup.systemInstruction.parts[0].text).toBe(ORB_SYSTEM_INSTRUCTION);
  });

  it("does not resolve before the server says setupComplete", async () => {
    let socket!: FakeSocket;
    const provider = geminiLiveProvider((url) => {
      socket = new FakeSocket(url);
      queueMicrotask(() => socket.emit("open", {}));
      return socket;
    });
    let resolved = false;
    const pending = provider
      .connect(realtimeConfig({ apiKey: "k", events: events() }))
      .then(() => {
        resolved = true;
      });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    socket.serverSays({ setupComplete: {} });
    await pending;
    expect(resolved).toBe(true);
  });

  it("rejects when the socket closes before setup completed", async () => {
    const provider = geminiLiveProvider((url) => {
      const socket = new FakeSocket(url);
      queueMicrotask(() => socket.emit("close", {}));
      return socket;
    });
    await expect(
      provider.connect(realtimeConfig({ apiKey: "k", events: events() })),
    ).rejects.toThrow(/closed before setup/);
  });
});

describe("the privacy default", () => {
  it("starts muted, and a muted session writes no audio to the wire", async () => {
    const { session, socket } = await connected();
    expect(session.muted).toBe(true);
    const framesBefore = socket.sent.length;
    session.sendAudio(new Uint8Array([1, 2, 3]));
    expect(socket.sent.length).toBe(framesBefore);
  });

  it("sends pcm 16k after unmute, and stops again after mute", async () => {
    const { session, socket } = await connected();
    session.unmute();
    session.sendAudio(new Uint8Array([1, 2, 3]));
    const frame = JSON.parse(socket.sent.at(-1)!);
    expect(frame.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(Buffer.from(frame.realtimeInput.audio.data, "base64")).toEqual(
      Buffer.from([1, 2, 3]),
    );
    session.mute();
    const framesBefore = socket.sent.length;
    session.sendAudio(new Uint8Array([4]));
    expect(socket.sent.length).toBe(framesBefore);
  });
});

describe("what the server sends back", () => {
  it("routes pcm parts to onAudio, decoded", async () => {
    const heard: Uint8Array[] = [];
    const { socket } = await connected(events({ onAudio: (chunk) => heard.push(chunk) }));
    socket.serverSays({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from([9, 9]).toString("base64") } },
            { inlineData: { mimeType: "image/png", data: "aaaa" } },
          ],
        },
      },
    });
    expect(heard).toHaveLength(1);
    expect(Buffer.from(heard[0])).toEqual(Buffer.from([9, 9]));
  });

  it("attributes transcriptions to their speakers", async () => {
    const lines: Array<[string, string]> = [];
    const { socket } = await connected(
      events({ onTranscript: (text, speaker) => lines.push([text, speaker]) }),
    );
    socket.serverSays({ serverContent: { inputTranscription: { text: "hey" } } });
    socket.serverSays({ serverContent: { outputTranscription: { text: "hello" } } });
    expect(lines).toEqual([
      ["hey", "user"],
      ["hello", "assistant"],
    ]);
  });

  it("routes toolCall to onFunctionCall", async () => {
    const calls: Array<{ id: string; name: string }> = [];
    const { socket } = await connected(
      events({ onFunctionCall: (call) => calls.push({ id: call.id, name: call.name }) }),
    );
    socket.serverSays({
      toolCall: { functionCalls: [{ id: "fc-1", name: HUB_FUNCTION_NAME, args: { request: "open my mail" } }] },
    });
    expect(calls).toEqual([{ id: "fc-1", name: HUB_FUNCTION_NAME }]);
  });

  it("reads interrupted as a barge-in", async () => {
    let bargedIn = false;
    const { socket } = await connected(events({ onBargeIn: () => (bargedIn = true) }));
    socket.serverSays({ serverContent: { interrupted: true } });
    expect(bargedIn).toBe(true);
  });

  it("survives a frame that is not json", async () => {
    const { socket } = await connected();
    socket.emit("message", { data: "not json at all" });
    // No throw is the assertion.
  });
});

describe("what the session sends", () => {
  it("sends text as a complete client turn", async () => {
    const { session, socket } = await connected();
    await session.sendText("the build finished");
    const frame = JSON.parse(socket.sent.at(-1)!);
    expect(frame.clientContent.turns[0].parts[0].text).toBe("the build finished");
    expect(frame.clientContent.turnComplete).toBe(true);
  });

  it("answers a function call through toolResponse with the matching id", async () => {
    const { session, socket } = await connected();
    await session.sendFunctionResult("fc-1", "done: two new emails");
    const frame = JSON.parse(socket.sent.at(-1)!);
    expect(frame.toolResponse.functionResponses[0].id).toBe("fc-1");
    expect(frame.toolResponse.functionResponses[0].response.output).toBe("done: two new emails");
  });
});

// The server hangs up on idle sessions. A drop this side did not ask for
// must be redialed — the alternative is an orb whose gate is open while
// every frame dies on a socket that will never answer again.
describe("when the server hangs up", () => {
  function reconnectingProvider(retryWait: () => Promise<void> = () => Promise.resolve()) {
    const sockets: FakeSocket[] = [];
    const provider = geminiLiveProvider((url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => {
        socket.emit("open", {});
        socket.serverSays({ setupComplete: {} });
      });
      return socket;
    }, retryWait);
    return { provider, sockets };
  }

  async function settle() {
    // The redial handshake runs on the microtask queue; a macrotask hop
    // lets it finish.
    await new Promise((r) => setTimeout(r, 10));
  }

  it("redials, and audio flows over the new socket without re-unmuting", async () => {
    const { provider, sockets } = reconnectingProvider();
    const session = await provider.connect(realtimeConfig({ apiKey: "k", events: events() }));
    session.unmute();

    sockets[0].emit("close", {});
    await settle();

    expect(sockets).toHaveLength(2);
    session.sendAudio(new Uint8Array([7]));
    const frame = JSON.parse(sockets[1].sent.at(-1)!);
    expect(frame.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
  });

  it("drops audio during the gap instead of throwing", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { provider, sockets } = reconnectingProvider(() => held);
    const session = await provider.connect(realtimeConfig({ apiKey: "k", events: events() }));
    session.unmute();

    sockets[0].emit("close", {});
    expect(() => session.sendAudio(new Uint8Array([1]))).not.toThrow();
    expect(sockets).toHaveLength(1);

    release();
    await settle();
    expect(sockets).toHaveLength(2);
  });

  it("unmute during the gap skips the backoff and dials right now", async () => {
    // A backoff that never resolves: the only way a redial can happen in
    // this test is the nudge.
    const { provider, sockets } = reconnectingProvider(() => new Promise<void>(() => {}));
    const session = await provider.connect(realtimeConfig({ apiKey: "k", events: events() }));

    sockets[0].emit("close", {});
    await settle();
    expect(sockets).toHaveLength(1);

    session.unmute();
    await settle();
    expect(sockets).toHaveLength(2);
    expect(session.connected).toBe(true);
  });

  it("a close from this side stays closed — no redial", async () => {
    const { provider, sockets } = reconnectingProvider();
    const session = await provider.connect(realtimeConfig({ apiKey: "k", events: events() }));
    await session.close();
    await settle();
    expect(sockets).toHaveLength(1);
    session.sendAudio(new Uint8Array([1]));
    // No throw, no new socket: hung up means hung up.
  });
});
