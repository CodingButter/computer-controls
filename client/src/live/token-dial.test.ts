import { describe, expect, it } from "vitest";

// How a client mouth dials: hub-minted single-use tokens, never a key.
// Added in segment 04, beside the moved session tests rather than inside
// them, so the move stays diffable against its old blob.
import {
  CONSTRAINED_ENDPOINT,
  LIVE_ENDPOINT,
  geminiLiveProvider,
  type SocketLike,
} from "./session.ts";
import { realtimeConfig, type RealtimeEvents } from "./live.ts";

const events = (overrides: Partial<RealtimeEvents> = {}): RealtimeEvents => ({
  onAudio: () => {},
  onTranscript: () => {},
  onFunctionCall: () => {},
  onBargeIn: () => {},
  ...overrides,
});

type Listener = (event: unknown) => void;

class FakeSocket implements SocketLike {
  url: string;
  binaryType?: string;
  sent: string[] = [];
  #listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener as Listener);
    this.#listeners.set(type, list);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  completeSetup(): void {
    this.emit("open", {});
    this.emit("message", { data: JSON.stringify({ setupComplete: {} }) });
  }

  serverCloses(code: number, reason: string): void {
    this.emit("close", { code, reason, wasClean: false });
  }
}

function tokenProvider() {
  const sockets: FakeSocket[] = [];
  const minted: string[] = [];
  let mints = 0;
  const provider = geminiLiveProvider(
    (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => socket.completeSetup());
      return socket;
    },
    () => Promise.resolve(),
  );
  const config = realtimeConfig({
    apiKey: "",
    mintToken: () => {
      const token = `auth_tokens/fresh-${++mints}`;
      minted.push(token);
      return Promise.resolve(token);
    },
    model: "gemini-x-live",
    events: events(),
  });
  return { provider, config, sockets, minted };
}

describe("dialing with a hub-minted token", () => {
  it("dials the constrained endpoint with the token, and no key anywhere", async () => {
    const { provider, config, sockets, minted } = tokenProvider();
    await provider.connect(config);

    expect(sockets[0].url).toBe(
      `${CONSTRAINED_ENDPOINT}?access_token=${encodeURIComponent(minted[0])}`,
    );
    // The exact match above is the pin; "Constrained" is what distinguishes
    // this endpoint from LIVE_ENDPOINT, of which it is a superstring.
    expect(sockets[0].url).not.toContain("key=");
  });

  it("repeats none of the constraints in the setup frame — they ride the token", async () => {
    const { provider, config, sockets } = tokenProvider();
    await provider.connect(config);

    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      setup: { model: "models/gemini-x-live" },
    });
  });

  it("mints a fresh token for every redial — a spent token opens nothing", async () => {
    const { provider, config, sockets, minted } = tokenProvider();
    await provider.connect(config);

    sockets[0].serverCloses(1011, "server hiccup");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sockets).toHaveLength(2);
    expect(minted).toEqual(["auth_tokens/fresh-1", "auth_tokens/fresh-2"]);
    expect(sockets[1].url).toContain(encodeURIComponent("auth_tokens/fresh-2"));
  });

  it("keeps the key path exactly as it was when no mint is supplied", async () => {
    const sockets: FakeSocket[] = [];
    const provider = geminiLiveProvider((url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => socket.completeSetup());
      return socket;
    });
    await provider.connect(
      realtimeConfig({ apiKey: "k", model: "gemini-x-live", events: events() }),
    );

    expect(sockets[0].url).toBe(`${LIVE_ENDPOINT}?key=k`);
    const setup = JSON.parse(sockets[0].sent[0]).setup;
    expect(setup.systemInstruction.parts[0].text).toContain("ask_the_hub");
    expect(setup.tools[0].functionDeclarations).toHaveLength(2);
  });

  it("surfaces a first-dial mint failure instead of opening anything", async () => {
    const sockets: FakeSocket[] = [];
    const provider = geminiLiveProvider((url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    });

    await expect(
      provider.connect(
        realtimeConfig({
          apiKey: "",
          mintToken: () => Promise.reject(new Error("The orb needs a Google account.")),
          model: "gemini-x-live",
          events: events(),
        }),
      ),
    ).rejects.toThrow(/Google account/);
    expect(sockets).toHaveLength(0);
  });
});
