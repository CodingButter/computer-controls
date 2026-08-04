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

  it("opens the door for the classes it was constructed with, without a tool", async () => {
    // A13: the model is never handed `grantScope`, so a minted write tool can
    // only ever succeed if the client asked for the class itself. If this
    // breaks, an agent configured for `edit` gets edit tools that always
    // refuse — the failure is silent, and it looks like a broken desktop.
    process.env.MASTRACODE_DESKTOP_SOCKET = socketPath;
    const supervisor = new DesktopSupervisor("door-gate");
    try {
      supervisor.setScope(["observe", "edit"], "a test that proves the client opens the door");
      await supervisor.request("getRevision", { clientId: "door-gate" });

      const audit = await supervisor.request<{ entries: { method: string; reason?: string }[] }>(
        "auditTail",
        { clientId: "door-gate", limit: 50 },
      );
      const grant = audit.entries.find((entry) => entry.method === "grantScope");
      expect(grant, "the client never asked for the scope it minted tools for").toBeDefined();
      expect(grant?.reason).toBe("a test that proves the client opens the door");
    } finally {
      supervisor.stop();
    }
  }, 30_000);

  it("asks for nothing when its scope is observe, which every connection already has", async () => {
    process.env.MASTRACODE_DESKTOP_SOCKET = socketPath;
    const supervisor = new DesktopSupervisor("quiet-gate");
    try {
      supervisor.setScope(["observe"], "reading only");
      await supervisor.request("getRevision", { clientId: "quiet-gate" });

      const audit = await supervisor.request<{ entries: { method: string; clientId?: string }[] }>(
        "auditTail",
        { clientId: "quiet-gate", limit: 50 },
      );
      const asked = audit.entries.some(
        (entry) => entry.method === "grantScope" && entry.clientId === "quiet-gate",
      );
      expect(asked, "an observe-only client asked for a grant it did not need").toBe(false);
    } finally {
      supervisor.stop();
    }
  }, 30_000);

  it("agrees with the service about where a daemon lives", () => {
    delete process.env.MASTRACODE_DESKTOP_SOCKET;
    expect(daemonSocketPath()).toMatch(/mastracode-desktop\/daemon-[0-9a-f]+\.sock$/);
  });
});
