import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DesktopClient, DesktopServiceError } from "./client.ts";
import { PROTOCOL_VERSION, SCHEMA_DIGEST } from "./protocol.generated.ts";

/**
 * Gets this plugin a desktop service to talk to, by one of two routes.
 *
 * If a shared daemon is already listening on its well-known socket, this
 * attaches to it and starts nothing. Otherwise it spawns a private service as
 * a child process, which stops when the plugin stops.
 *
 * The order matters more than it looks. Two services on one desktop would each
 * hold their own element registry and their own revision counter, so an
 * element id minted by one would be meaningless to the other and neither could
 * tell the other's actions from a human's. Attaching first makes "one desktop,
 * several clients" the default and the private child the fallback, rather than
 * the other way round.
 */

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "..");

export const SERVICE_ROOT = join(repoRoot, "service");
export const SERVICE_PYTHON = join(SERVICE_ROOT, ".venv", "bin", "python");

const START_TIMEOUT_MS = 20_000;

/** Where a shared desktop service listens. Mirrors the service's own default. */
export function daemonSocketPath(): string {
  const explicit = process.env.MASTRACODE_DESKTOP_SOCKET;
  if (explicit) return explicit;
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  return join(runtimeDir, "mastracode-desktop", `daemon-${SCHEMA_DIGEST}.sock`);
}

export class DesktopSupervisor {
  #process: ChildProcess | undefined;
  #client: DesktopClient | undefined;
  #starting: Promise<DesktopClient> | undefined;
  #exitCleanupArmed = false;
  #attached = false;
  #schemaDigest: string | undefined;
  readonly #sessionName: string;

  constructor(sessionName = `mc-${process.pid}`) {
    this.#sessionName = sessionName;
  }

  get running(): boolean {
    if (this.#attached) return this.#client?.connected === true;
    return this.#process !== undefined && this.#process.exitCode === null;
  }

  /** Whether this client attached to a service it does not own. */
  get attached(): boolean {
    return this.#attached;
  }

  async client(): Promise<DesktopClient> {
    if (this.#client?.connected) return this.#client;
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return await this.#starting;
  }

  /**
   * Kill the service when this process goes away.
   *
   * The service also arms `PR_SET_PDEATHSIG` for the cases these handlers never
   * see (SIGKILL, a hard crash). This is the graceful half of the same job.
   */
  #armExitCleanup(): void {
    if (this.#exitCleanupArmed) return;
    this.#exitCleanupArmed = true;
    process.once("exit", () => this.stop());
    // On a signal, cleaning up is not enough: Node installs no default handler
    // once one is registered, so the process would keep running with nothing
    // left to do and the terminal would need a second Ctrl-C to get out.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        this.stop();
        if (process.listenerCount(signal) === 0) {
          process.exit(signal === "SIGINT" ? 130 : 143);
        }
      });
    }
  }

  /**
   * Attach to a shared daemon if one is listening.
   *
   * A stale socket file left by a service that died is common enough that its
   * mere presence proves nothing; the connection attempt is the test. Failure
   * here is not an error — it is the ordinary case where no daemon is running.
   */
  async #attach(): Promise<DesktopClient | undefined> {
    const socketPath = daemonSocketPath();
    if (!existsSync(socketPath)) return undefined;
    const client = new DesktopClient({ socketPath });
    try {
      await client.connect();
    } catch {
      client.close();
      return undefined;
    }
    this.#attached = true;
    this.#client = client;
    return client;
  }

  /**
   * Connect to a shared daemon if one is listening, and start nothing if not.
   *
   * The push lane calls this. It runs on every turn of every session, including
   * the ones that never touch the desktop, so it may attach to a service that
   * exists but must never bring one into being.
   */
  async attachIfListening(): Promise<boolean> {
    if (this.#client?.connected) return true;
    return (await this.#attach()) !== undefined;
  }

  async #start(): Promise<DesktopClient> {
    const attached = await this.#attach();
    if (attached) return attached;

    if (!existsSync(SERVICE_PYTHON)) {
      throw new DesktopServiceError(
        "BACKEND_UNAVAILABLE",
        `The desktop service virtualenv is missing at ${SERVICE_PYTHON}. ` +
          "Create it with: python3 -m venv --system-site-packages service/.venv",
        { pythonPath: SERVICE_PYTHON },
      );
    }

    const child = spawn(SERVICE_PYTHON, ["-m", "desktop_service", "--session", this.#sessionName], {
      cwd: SERVICE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.#process = child;
    this.#armExitCleanup();

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const socketPath = await new Promise<string>((resolvePath, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(
          new DesktopServiceError(
            "TIMEOUT",
            `The desktop service did not report a socket within ${START_TIMEOUT_MS}ms`,
            { stderr: stderr.slice(-2000) },
          ),
        );
      }, START_TIMEOUT_MS);

      let stdout = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        const match = /^listening (.+)$/m.exec(stdout);
        if (match) {
          clearTimeout(timer);
          resolvePath(match[1]!.trim());
        }
      });

      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new DesktopServiceError(
            "BACKEND_UNAVAILABLE",
            `The desktop service exited with code ${code} before it was ready`,
            { stderr: stderr.slice(-2000) },
          ),
        );
      });
    });

    const client = new DesktopClient({ socketPath });
    await client.connect();
    this.#client = client;
    return client;
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    const client = await this.client();
    return await client.request<T>(method, params, timeoutMs);
  }

  /**
   * The schema version the service on the other end was built from.
   *
   * Asked lazily and remembered, because the answer cannot change without the
   * connection dropping: one process, one build. `undefined` means the service
   * is old enough to predate the field, which is itself the answer a caller
   * wants when a method it expected is missing.
   */
  async schemaDigest(): Promise<string | undefined> {
    if (this.#schemaDigest === undefined) {
      const hello = await this.request<{ schemaDigest?: string }>("hello", {
        clientId: this.#sessionName,
        protocolVersion: PROTOCOL_VERSION,
      });
      this.#schemaDigest = hello.schemaDigest ?? "";
    }
    return this.#schemaDigest || undefined;
  }

  /**
   * Let go of the service.
   *
   * A private child is killed. A shared daemon is only disconnected from: other
   * clients are still using it, and it was running before this process started.
   */
  stop(): void {
    this.#client?.close();
    this.#client = undefined;
    this.#attached = false;
    const child = this.#process;
    this.#process = undefined;
    child?.kill("SIGTERM");
  }
}
