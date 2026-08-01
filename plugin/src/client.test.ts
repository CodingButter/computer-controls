import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DesktopClient, DesktopServiceError } from "./client.ts";

/**
 * The client is tested against a stub socket server rather than the real
 * service: what is under test here is framing, correlation and failure
 * behavior, none of which should need a desktop to exercise.
 */

type Responder = (request: {
  id: number;
  method: string;
  params: Record<string, unknown>;
}) => Record<string, unknown> | undefined;

let dir: string;
let server: Server | undefined;
let socketPath: string;
const sockets = new Set<Socket>();

function startStub(responder: Responder): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line) continue;
          const response = responder(JSON.parse(line));
          if (response) socket.write(`${JSON.stringify(response)}\n`);
        }
      });
      socket.on("error", () => {});
    });
    server.listen(socketPath, () => resolve());
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-client-"));
  socketPath = join(dir, "test.sock");
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("DesktopClient", () => {
  it("round trips a request", async () => {
    await startStub(({ id, method, params }) => ({
      jsonrpc: "2.0",
      id,
      result: { method, params },
    }));

    const client = new DesktopClient({ socketPath });
    try {
      const result = await client.request("listWindows", { applicationId: "app-1" });
      expect(result).toEqual({
        method: "listWindows",
        params: { applicationId: "app-1" },
      });
    } finally {
      client.close();
    }
  });

  it("correlates concurrent responses by id, not by arrival order", async () => {
    // The stub answers out of order on purpose: the second request is answered
    // first. A client that matched responses positionally would swap them.
    const held: Array<{ id: number; value: string }> = [];
    await startStub(({ id, params }) => {
      held.push({ id, value: String(params.value) });
      if (held.length < 2) return undefined;
      const [first, second] = held;
      const socket = [...sockets][0]!;
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: second!.id, result: { value: second!.value } })}\n`,
      );
      return { jsonrpc: "2.0", id: first!.id, result: { value: first!.value } };
    });

    const client = new DesktopClient({ socketPath });
    try {
      const [a, b] = await Promise.all([
        client.request<{ value: string }>("echo", { value: "first" }),
        client.request<{ value: string }>("echo", { value: "second" }),
      ]);
      expect(a.value).toBe("first");
      expect(b.value).toBe("second");
    } finally {
      client.close();
    }
  });

  it("turns a service error into a DesktopServiceError carrying the code", async () => {
    await startStub(({ id }) => ({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: "No application with id 'app-nope' is running",
        data: { code: "APPLICATION_NOT_FOUND", detail: { applicationId: "app-nope" } },
      },
    }));

    const client = new DesktopClient({ socketPath });
    try {
      await expect(client.request("listWindows")).rejects.toThrow(DesktopServiceError);
      await client.request("listWindows").catch((error: DesktopServiceError) => {
        expect(error.code).toBe("APPLICATION_NOT_FOUND");
        expect(error.detail).toEqual({ applicationId: "app-nope" });
      });
    } finally {
      client.close();
    }
  });

  it("times out when the service never answers", async () => {
    await startStub(() => undefined);

    const client = new DesktopClient({ socketPath, requestTimeoutMs: 120 });
    try {
      await expect(client.request("listWindows")).rejects.toMatchObject({
        code: "TIMEOUT",
      });
    } finally {
      client.close();
    }
  });

  it("reports a clear error when the service is not running", async () => {
    const client = new DesktopClient({ socketPath: join(dir, "absent.sock") });
    try {
      await expect(client.request("listWindows")).rejects.toMatchObject({
        code: "BACKEND_UNAVAILABLE",
      });
      await client.request("listWindows").catch((error: DesktopServiceError) => {
        expect(error.message).toContain("not running");
      });
    } finally {
      client.close();
    }
  });

  it("rejects in-flight requests when the service disappears", async () => {
    await startStub(() => undefined);

    const client = new DesktopClient({ socketPath, requestTimeoutMs: 5_000 });
    try {
      const pending = client.request("listWindows");
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const socket of sockets) socket.destroy();
      await expect(pending).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    } finally {
      client.close();
    }
  });

  it("handles a response split across chunk boundaries", async () => {
    await startStub(({ id }) => {
      const socket = [...sockets][0]!;
      const payload = JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } });
      socket.write(payload.slice(0, 10));
      setTimeout(() => socket.write(`${payload.slice(10)}\n`), 20);
      return undefined;
    });

    const client = new DesktopClient({ socketPath });
    try {
      await expect(client.request("listWindows")).resolves.toEqual({ ok: true });
    } finally {
      client.close();
    }
  });
});
