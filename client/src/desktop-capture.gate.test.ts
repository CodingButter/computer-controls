import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SERVICE_PYTHON, SERVICE_ROOT } from "../../clients/mastra-plugin/src/supervisor.ts";
import { DesktopClient } from "../../clients/shared/src/desktop-client.ts";
import { createDesktopCapture } from "./desktop-capture.ts";

/**
 * The hub's read path to the daemon's capture, exercised end-to-end.
 *
 * Mirrors comcon/tests/test_capture_live.py: the daemon's own dimensional
 * proof (a11y bounds ≡ drawable geometry ≡ encoded PNG size) lives there,
 * because the Python side is the one that can query AT-SPI. The blocked-app
 * refusal is unit-tested on the route side (APPLICATION_NOT_FOUND → 403) and
 * live-tested on the daemon side. Here we prove the thinner thing the hub
 * owns — that its DesktopClient reaches the daemon socket, pulls a real PNG,
 * and that a missing daemon surfaces as an error the hub does not swallow.
 *
 * Gate test: needs the daemon's venv, an X display with at least one visible
 * window. Run deliberately with `pnpm test:gate` on a desktop session.
 */

const hasDisplay = Boolean(process.env.DISPLAY) || existsSync("/tmp/.X11-unix");
const hasVenv = existsSync(SERVICE_PYTHON);
const canSpawn = hasDisplay && hasVenv;

const socketPath = join("/tmp", `desktop-capture-gate-${process.pid}.sock`);

let daemon: ChildProcess | undefined;
let firstWindowId: string | undefined;

beforeAll(async () => {
  if (!canSpawn) return;
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
  // A desktop with no visible windows cannot be captured. Probe before the
  // tests so they can skip cleanly rather than fail on an environment fact.
  const probe = new DesktopClient({ socketPath });
  try {
    const state = await probe.request<{ windows: { windowId: string }[] }>("getDesktopState", {});
    firstWindowId = state.windows[0]?.windowId;
  } catch {
    // AT-SPI or the display server may not be available even though the
    // socket directory exists. The tests will skip.
  }
  probe.close();
}, 30_000);

afterAll(() => {
  daemon?.kill("SIGTERM");
});

describe.skipIf(!canSpawn)("the hub's capture path to a live daemon", () => {
  it("pulls a real PNG frame for a visible window", { skip: !firstWindowId }, async () => {
    expect(firstWindowId).toBeDefined();

    const captureFrame = createDesktopCapture(socketPath);
    const result = await captureFrame(firstWindowId!);

    expect(result.refused).toBe(false);
    if (result.refused) return;
    expect(result.format).toBe("png");

    // PNG magic bytes — proves the daemon returned a real image, not noise.
    const bytes = Buffer.from(result.image, "base64");
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50); // P
    expect(bytes[2]).toBe(0x4e); // N
    expect(bytes[3]).toBe(0x47); // G
  });

  it("a missing daemon surfaces as an error the hub does not swallow", async () => {
    const captureFrame = createDesktopCapture(join("/tmp", `nonexistent-${process.pid}.sock`));
    await expect(captureFrame("any-window")).rejects.toThrow();
  });
});
