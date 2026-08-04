/**
 * The hub's own door onto the desktop daemon.
 *
 * The hub and the daemon are separate processes. The plugin bridges them for
 * agent tools, but the permissions page is not an agent tool — it is a
 * user-facing surface the hub serves directly. So the hub opens its own
 * connection to the daemon's well-known socket, speaks the same newline-framed
 * JSON-RPC 2.0 the plugin does, and calls the two registry methods
 * (getApplicationPermissions / setApplicationPermission) that live on the
 * socket but were deliberately left out of the plugin's tool catalogue.
 *
 * That is how ruling 1 holds: the method exists, the hub can reach it, and no
 * prompt can induce a model to call a tool it was never handed.
 */

import { connect, type Socket } from "node:net";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the daemon listens. Mirrors the plugin's own derivation in
 * supervisor.ts: an explicit override wins, otherwise the well-known runtime
 * directory holds a single `daemon-{digest}.sock` — there is only ever one
 * daemon per machine, so finding it by glob avoids hardcoding the schema digest.
 */
export function daemonSocketPath(): string {
  const explicit = process.env.MASTRACODE_DESKTOP_SOCKET;
  if (explicit) return explicit;

  const runtimeDir =
    process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  const dir = join(runtimeDir, "mastracode-desktop");
  try {
    const socks = readdirSync(dir).filter((name) =>
      name.startsWith("daemon-") && name.endsWith(".sock"),
    );
    if (socks.length > 0) return join(dir, socks[0]!);
  } catch {
    // Directory does not exist — the daemon has not been started yet.
  }
  // Fall back to the default pattern so the error message names a real path.
  return join(dir, "daemon-unknown.sock");
}

const REQUEST_TIMEOUT_MS = 5_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A minimal JSON-RPC client for the two registry methods. Smaller than the
 * plugin's DesktopClient because the hub only needs fire-and-forget calls to
 * getApplicationPermissions and setApplicationPermission — no multi-in-flight
 * concurrency, no reconnection, no paced timeouts.
 */
export class DaemonRegistryClient {
  readonly #socketPath: string;
  #socket: Socket | undefined;
  #buffer = "";
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();

  constructor(socketPath: string = daemonSocketPath()) {
    this.#socketPath = socketPath;
  }

  async getApplicationPermissions(): Promise<{
    applications: { name: string; permitted: boolean }[];
  }> {
    return this.#request("getApplicationPermissions", {});
  }

  async setApplicationPermission(
    application: string,
    permitted: boolean,
  ): Promise<{ application: string; permitted: boolean }> {
    return this.#request("setApplicationPermission", { application, permitted });
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = undefined;
  }

  async #request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.#connect();
    const socket = this.#socket;
    if (!socket) throw new Error("Desktop daemon is not connected.");

    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`The desktop daemon did not answer ${method} within ${REQUEST_TIMEOUT_MS}ms.`));
      }, REQUEST_TIMEOUT_MS);

      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  #connect(): Promise<void> {
    if (this.#socket && !this.#socket.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = connect(this.#socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Could not connect to the desktop daemon at ${this.#socketPath}.`));
      }, 3_000);

      socket.once("connect", () => {
        clearTimeout(timer);
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => this.#onData(chunk));
        socket.on("close", () => this.#onClose());
        socket.on("error", () => {
          /* surfaced through pending rejections and the close handler */
        });
        this.#socket = socket;
        resolve();
      });

      socket.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new Error(
            error.code === "ENOENT" || error.code === "ECONNREFUSED"
              ? "The desktop daemon is not running."
              : `Could not connect to the desktop daemon: ${error.message}`,
          ),
        );
      });
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#onLine(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "The desktop daemon returned an error."));
      return;
    }
    pending.resolve(message.result);
  }

  #onClose(): void {
    this.#socket = undefined;
    const error = new Error("The desktop daemon closed the connection.");
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
