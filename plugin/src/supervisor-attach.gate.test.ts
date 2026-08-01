import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DesktopSupervisor, SERVICE_PYTHON, SERVICE_ROOT, daemonSocketPath } from "./supervisor.ts";

/**
 * Whether a client attaches to a running desktop service or starts its own.
 *
 * This runs the real service, because the thing being tested is a connection to
 * a socket that either has something behind it or does not. A fake would prove
 * only that the code branches the way it is written.
 */

const socketPath = join("/tmp", `desktop-attach-gate-${process.pid}.sock`);
const available = existsSync(SERVICE_PYTHON);

let daemon: ChildProcess | undefined;

beforeAll(async () => {
  if (!available) return;
  daemon = spawn(SERVICE_PYTHON, ["-m", "desktop_service", "--daemon", "--socket", socketPath], {
    cwd: SERVICE_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon never reported a socket")), 20_000);
    daemon?.stdout?.setEncoding("utf8");
    daemon?.stdout?.on("data", (chunk: string) => {
      if (chunk.includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}, 30_000);

afterAll(() => {
  daemon?.kill("SIGTERM");
});

describe.skipIf(!available)("finding a desktop service", () => {
  it("attaches to a daemon that is already listening", async () => {
    process.env.MASTRACODE_DESKTOP_SOCKET = socketPath;
    const supervisor = new DesktopSupervisor("attach-gate");
    try {
      const state = await supervisor.request<{ windows: unknown[] }>("getDesktopState", {
        clientId: "attach-gate",
      });
      expect(supervisor.attached).toBe(true);
      expect(supervisor.running).toBe(true);
      expect(Array.isArray(state.windows)).toBe(true);
    } finally {
      supervisor.stop();
    }
  }, 30_000);

  it("leaves the daemon running when a client that attached lets go", async () => {
    // The client did not start it and does not get to end it. Killing a shared
    // service on disconnect would take the desktop out from under every other
    // client the moment one of them exited.
    process.env.MASTRACODE_DESKTOP_SOCKET = socketPath;
    const first = new DesktopSupervisor("attach-gate-a");
    await first.request("getRevision", { clientId: "attach-gate-a" });
    first.stop();

    const second = new DesktopSupervisor("attach-gate-b");
    try {
      await second.request("getRevision", { clientId: "attach-gate-b" });
      expect(second.attached).toBe(true);
    } finally {
      second.stop();
    }
  }, 30_000);

  it("starts its own service when no daemon is listening", async () => {
    process.env.MASTRACODE_DESKTOP_SOCKET = join("/tmp", `absent-${process.pid}.sock`);
    const supervisor = new DesktopSupervisor("spawn-gate");
    try {
      await supervisor.request("getRevision", { clientId: "spawn-gate" });
      expect(supervisor.attached).toBe(false);
      expect(supervisor.running).toBe(true);
    } finally {
      supervisor.stop();
    }
  }, 40_000);

  it("agrees with the service about where a daemon lives", () => {
    delete process.env.MASTRACODE_DESKTOP_SOCKET;
    expect(daemonSocketPath()).toMatch(/mastracode-desktop\/daemon\.sock$/);
  });
});
