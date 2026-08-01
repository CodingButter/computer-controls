import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DesktopClient, DesktopServiceError } from "./client.ts";

/**
 * Starts the Python desktop service on demand and keeps one instance per plugin
 * session. The service is a child process, not a daemon: when the plugin stops,
 * the desktop service stops with it.
 */

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "..");

export const SERVICE_ROOT = join(repoRoot, "service");
export const SERVICE_PYTHON = join(SERVICE_ROOT, ".venv", "bin", "python");

const START_TIMEOUT_MS = 20_000;

export class DesktopSupervisor {
  #process: ChildProcess | undefined;
  #client: DesktopClient | undefined;
  #starting: Promise<DesktopClient> | undefined;
  #exitCleanupArmed = false;
  readonly #sessionName: string;

  constructor(sessionName = `mc-${process.pid}`) {
    this.#sessionName = sessionName;
  }

  get running(): boolean {
    return this.#process !== undefined && this.#process.exitCode === null;
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
    const stop = () => this.stop();
    process.once("exit", stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }

  async #start(): Promise<DesktopClient> {
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
  ): Promise<T> {
    const client = await this.client();
    return await client.request<T>(method, params);
  }

  stop(): void {
    this.#client?.close();
    this.#client = undefined;
    const child = this.#process;
    this.#process = undefined;
    child?.kill("SIGTERM");
  }
}
