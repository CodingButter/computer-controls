import { describe, expect, it } from "vitest";

import {
  LIVE_ENDPOINT,
  ORB_SYSTEM_INSTRUCTION,
  geminiLiveProvider,
  type SocketLike,
} from "./session.ts";
import { HUB_FUNCTION_NAME, LIVE_VOICE, STOP_LISTENING_NAME, realtimeConfig, type RealtimeEvents } from "./live.ts";

// Everything below this import block moved verbatim from live-gemini.test.ts;
// the one addition (adversarial review, segment 03) is the malformed-base64
// test near the end, pinning that a bad audio blob is dropped, never thrown.

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

  /** Simulate the server closing the socket with a close code + reason. */
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

  it("sends setup as the first frame, with the model, both tools, and both transcriptions", async () => {
    const { socket } = await connected();
    const first = JSON.parse(socket.sent[0]);
    expect(first.setup.model).toMatch(/^models\//);
    expect(first.setup.tools).toHaveLength(1);
    const declarations = first.setup.tools[0].functionDeclarations;
    expect(declarations).toHaveLength(2);
    expect(declarations[0].name).toBe(HUB_FUNCTION_NAME);
    expect(declarations[1].name).toBe(STOP_LISTENING_NAME);
    expect(first.setup.inputAudioTranscription).toEqual({});
    expect(first.setup.outputAudioTranscription).toEqual({});
    expect(first.setup.systemInstruction.parts[0].text).toBe(ORB_SYSTEM_INSTRUCTION);
  });

  it("names the voice in setup, so the provider's default cannot move underneath it", async () => {
    const { socket } = await connected();
    const first = JSON.parse(socket.sent[0]);
    expect(first.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      LIVE_VOICE,
    );
  });

  it("sends the chosen prebuilt voice in speechConfig", async () => {
    let socket!: FakeSocket;
    const provider = geminiLiveProvider((url) => {
      socket = new FakeSocket(url);
      queueMicrotask(() => {
        socket.emit("open", {});
        socket.serverSays({ setupComplete: {} });
      });
      return socket;
    });
    await provider.connect(
      realtimeConfig({ apiKey: "test-key", voice: "Aoede", events: events() }),
    );
    const first = JSON.parse(socket.sent[0]);
    expect(first.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Aoede");
  });

  it("sends the chosen model instead of the default", async () => {
    let socket!: FakeSocket;
    const provider = geminiLiveProvider((url) => {
      socket = new FakeSocket(url);
      queueMicrotask(() => {
        socket.emit("open", {});
        socket.serverSays({ setupComplete: {} });
      });
      return socket;
    });
    await provider.connect(
      realtimeConfig({ apiKey: "test-key", model: "gemini-3.1-pro-live-preview", events: events() }),
    );
    const first = JSON.parse(socket.sent[0]);
    expect(first.setup.model).toBe("models/gemini-3.1-pro-live-preview");
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

  it("drops a malformed base64 audio blob instead of throwing (added in segment 03)", async () => {
    // atob rejects what Buffer.from tolerated; a frame that does not decode
    // is a frame we never saw — one bad blob must not take down the session.
    const heard: Uint8Array[] = [];
    const { socket } = await connected(events({ onAudio: (chunk) => heard.push(chunk) }));
    expect(() =>
      socket.serverSays({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "!!!not base64!!!" } }],
          },
        },
      }),
    ).not.toThrow();
    expect(heard).toHaveLength(0);
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

// A retired model (1008) or a policy rejection (4xxx) is permanent — retrying
// the same model loops forever. The orb must say so and stop, not redial a
// socket the provider will refuse again. This is the exact bug that left the
// orb mute in #129: a silent close, redial forever, nobody told the person.
describe("permanent refusal — retired model or policy reject", () => {
  it("rejects the dial when a 1008 arrives during setup", async () => {
    let socket!: FakeSocket;
    const provider = geminiLiveProvider((url) => {
      socket = new FakeSocket(url);
      queueMicrotask(() => {
        socket.emit("open", {});
        socket.serverCloses(1008, "model not found");
      });
      return socket;
    });
    await expect(
      provider.connect(realtimeConfig({ apiKey: "k", model: "gemini-x-live", events: events() })),
    ).rejects.toThrow(/refused the model 'gemini-x-live'.*model not found/s);
  });

  it("fires onRefusal and stops redialing on a post-setup 1008", async () => {
    const refused: string[] = [];
    const eventHandlers = events({ onRefusal: (reason) => refused.push(reason) });

    const sockets: FakeSocket[] = [];
    const provider = geminiLiveProvider((url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => {
        socket.emit("open", {});
        socket.serverSays({ setupComplete: {} });
      });
      return socket;
    }, () => Promise.resolve());

    const session = await provider.connect(
      realtimeConfig({ apiKey: "k", model: "gemini-x-live", events: eventHandlers }),
    );
    expect(session.connected).toBe(true);

    sockets[0].serverCloses(1008, "model not found");
    await new Promise((r) => setTimeout(r, 10));

    expect(refused[0]).toMatch(/refused the model 'gemini-x-live'/);
    expect(refused[0]).toMatch(/model not found/);
    // No second socket — the redial loop was stopped.
    expect(sockets).toHaveLength(1);
    expect(session.connected).toBe(false);
  });

  it("still redials a 1000 idle close", async () => {
    const refused: string[] = [];
    const eventHandlers = events({ onRefusal: (reason) => refused.push(reason) });

    const sockets: FakeSocket[] = [];
    const provider = geminiLiveProvider((url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => {
        socket.emit("open", {});
        socket.serverSays({ setupComplete: {} });
      });
      return socket;
    }, () => Promise.resolve());

    const session = await provider.connect(realtimeConfig({ apiKey: "k", events: eventHandlers }));

    sockets[0].serverCloses(1000);
    await new Promise((r) => setTimeout(r, 10));

    // A 1000 is transient — redial happened, no refusal fired.
    expect(refused).toHaveLength(0);
    expect(sockets).toHaveLength(2);
    expect(session.connected).toBe(true);
  });

  // The live failure this rule was written from: the provider closed 1008 with
  // "The operation was aborted." and the orb went off wearing a message that
  // blamed a model which — probed directly with the same setup frame, three
  // times — connects fine. A drop the server did not blame the model for is a
  // drop, and the redial loop is what it is for.
  it("redials a 1008 whose reason does not name the model", async () => {
    const refused: string[] = [];
    const eventHandlers = events({ onRefusal: (reason) => refused.push(reason) });

    const sockets: FakeSocket[] = [];
    const provider = geminiLiveProvider((url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => {
        socket.emit("open", {});
        socket.serverSays({ setupComplete: {} });
      });
      return socket;
    }, () => Promise.resolve());

    const session = await provider.connect(realtimeConfig({ apiKey: "k", events: eventHandlers }));

    sockets[0].serverCloses(1008, "The operation was aborted.");
    await new Promise((r) => setTimeout(r, 10));

    expect(refused).toHaveLength(0);
    expect(sockets).toHaveLength(2);
    expect(session.connected).toBe(true);
  });

  it("rejects the dial, but does not give up, on a setup-time abort", async () => {
    let dials = 0;
    const provider = geminiLiveProvider((url) => {
      dials++;
      const socket = new FakeSocket(url);
      queueMicrotask(() => {
        socket.emit("open", {});
        socket.serverCloses(1008, "The operation was aborted.");
      });
      return socket;
    });
    // The first dial still refuses — a hub that cannot reach the provider at
    // boot says so — but it refuses as a socket that closed, not as a model
    // the provider named.
    await expect(
      provider.connect(realtimeConfig({ apiKey: "k", model: "gemini-x-live", events: events() })),
    ).rejects.toThrow(/closed before setup completed/);
    expect(dials).toBe(1);
  });

  it("treats a 4xxx close as permanent", async () => {
    const refused: string[] = [];
    const eventHandlers = events({ onRefusal: (reason) => refused.push(reason) });

    const sockets: FakeSocket[] = [];
    const provider = geminiLiveProvider((url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => {
        socket.emit("open", {});
        socket.serverSays({ setupComplete: {} });
      });
      return socket;
    }, () => Promise.resolve());

    await provider.connect(
      realtimeConfig({ apiKey: "k", model: "gemini-x-live", events: eventHandlers }),
    );

    sockets[0].serverCloses(4004, "quota exceeded");
    await new Promise((r) => setTimeout(r, 10));

    expect(refused[0]).toMatch(/refused the model 'gemini-x-live'/);
    expect(sockets).toHaveLength(1);
  });
});
