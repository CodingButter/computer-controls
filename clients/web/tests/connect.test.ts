import { describe, it, expect } from "vitest";
import { connect, ConnectError } from "../src/connect.ts";

// Mock global fetch + WebSocket for connect() tests.
// We can't hit a real server in unit tests.

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  fireOpen() {
    this.onopen?.();
  }

  fireError() {
    this.onerror?.();
  }
}

// Inject mock WebSocket into the module's scope.
globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

describe("connect", () => {
  it("trades secret for token and opens a WebSocket", async () => {
    const fetchMock = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ token: "test-bearer-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    MockWebSocket.instances = [];
    const promise = connect("https://computer.lan:8000", "my-secret");

    // The WebSocket should be created; simulate a successful open.
    await new Promise((r) => setTimeout(r, 10));
    MockWebSocket.instances[0]?.fireOpen();

    const result = await promise;

    expect(result.token).toBe("test-bearer-token");
    expect(result.ws).toBeDefined();
    expect(MockWebSocket.instances[0].url).toContain("wss://computer.lan:8000/ws");
    expect(MockWebSocket.instances[0].url).toContain("token=test-bearer-token");

    globalThis.fetch = fetchMock;
  });

  it("throws ConnectError on wrong secret (401)", async () => {
    const fetchMock = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "invalid secret" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    await expect(connect("https://computer.lan:8000", "wrong")).rejects.toThrow(
      ConnectError,
    );

    globalThis.fetch = fetchMock;
  });

  it("throws ConnectError when WebSocket fails to connect", async () => {
    const fetchMock = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ token: "tok" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    MockWebSocket.instances = [];
    const promise = connect("https://computer.lan:8000", "secret");

    await new Promise((r) => setTimeout(r, 10));
    MockWebSocket.instances[0]?.fireError();

    await expect(promise).rejects.toThrow(ConnectError);

    globalThis.fetch = fetchMock;
  });

  it("uses ws: protocol for http URLs", async () => {
    const fetchMock = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ token: "tok" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    MockWebSocket.instances = [];
    const promise = connect("http://localhost:8000", "secret");

    await new Promise((r) => setTimeout(r, 10));
    MockWebSocket.instances[0]?.fireOpen();

    await promise;

    expect(MockWebSocket.instances[0].url).toContain("ws://localhost:8000/ws");

    globalThis.fetch = fetchMock;
  });
});
