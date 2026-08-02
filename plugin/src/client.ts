import { connect, type Socket } from "node:net";

/**
 * The Node side of the desktop service transport.
 *
 * Newline-framed JSON-RPC 2.0 over a Unix socket: one request per line, one
 * response per line, correlated by id. The client owns the correlation table so
 * several tool calls can be in flight against one connection.
 */

export interface DesktopErrorData {
  code: string;
  detail?: Record<string, unknown>;
}

export class DesktopServiceError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "DesktopServiceError";
    this.code = code;
    this.detail = detail;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DesktopClientOptions {
  socketPath: string;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export class DesktopClient {
  readonly socketPath: string;
  readonly #requestTimeoutMs: number;
  readonly #connectTimeoutMs: number;
  #socket: Socket | undefined;
  #buffer = "";
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();

  constructor(options: DesktopClientOptions) {
    this.socketPath = options.socketPath;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  get connected(): boolean {
    return this.#socket !== undefined && !this.#socket.destroyed;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const socket = connect(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new DesktopServiceError(
            "BACKEND_UNAVAILABLE",
            `Timed out connecting to the desktop service at ${this.socketPath}`,
            { socketPath: this.socketPath },
          ),
        );
      }, this.#connectTimeoutMs);

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
        socket.destroy();
        reject(
          new DesktopServiceError(
            "BACKEND_UNAVAILABLE",
            error.code === "ENOENT" || error.code === "ECONNREFUSED"
              ? `The desktop service is not running (no socket at ${this.socketPath})`
              : `Could not connect to the desktop service: ${error.message}`,
            { socketPath: this.socketPath, syscallCode: error.code },
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
    let message: {
      id?: number;
      result?: unknown;
      error?: { message?: string; data?: DesktopErrorData };
    };
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
      pending.reject(
        new DesktopServiceError(
          message.error.data?.code ?? "INTERNAL_ERROR",
          message.error.message ?? "The desktop service returned an error",
          message.error.data?.detail ?? {},
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  #onClose(): void {
    this.#socket = undefined;
    const error = new DesktopServiceError(
      "BACKEND_UNAVAILABLE",
      "The desktop service closed the connection",
      { socketPath: this.socketPath },
    );
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  /**
   * @param timeoutMs Overrides the default deadline for this one call. A method
   * that deliberately takes time — typing a sentence at human speed — knows how
   * long it will take before it starts, and cutting the connection at a fixed
   * twenty seconds would abandon an action that is still running perfectly well
   * on the far side of the socket.
   */
  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    await this.connect();
    const socket = this.#socket;
    if (!socket) {
      throw new DesktopServiceError(
        "BACKEND_UNAVAILABLE",
        "The desktop service is not connected",
        { socketPath: this.socketPath },
      );
    }

    const id = this.#nextId++;
    const deadline = timeoutMs ?? this.#requestTimeoutMs;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new DesktopServiceError(
            "TIMEOUT",
            `The desktop service did not answer ${method} within ${deadline}ms`,
            { method, timeoutMs: deadline },
          ),
        );
      }, deadline);

      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(
        new DesktopServiceError("BACKEND_UNAVAILABLE", "The client was closed", {}),
      );
    }
    socket?.destroy();
  }
}
