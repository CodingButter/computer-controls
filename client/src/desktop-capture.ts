/**
 * The hub's read path to the desktop daemon's window capture.
 *
 * The orb's stream route needs to pull a window's pixels on demand, but the hub
 * has never had a direct path to the daemon — only the plugin's supervisor does,
 * and that path is the agent's (it may spawn a private daemon, it carries write
 * scope). This is the hub's own thin client: it connects to whatever shared
 * daemon is already listening, never spawns one, and calls the one observe-class
 * method a fresh connection already may — `captureWindow`.
 *
 * The daemon enforces capture_refusal before any pixels, so a blocked app
 * surfaces here as APPLICATION_NOT_FOUND (the same code a genuinely gone window
 * raises — the hub neither can nor needs to tell them apart). That is mapped to
 * a refusal; everything else the daemon cannot satisfy propagates as a throw,
 * which the stream route turns into a 503. A connection that drops mid-stream
 * rejects in-flight pulls the same way, closing the stream cleanly.
 */

import { DesktopClient, DesktopServiceError } from "../../clients/mastra-plugin/src/client.ts";
import { daemonSocketPath } from "../../clients/mastra-plugin/src/supervisor.ts";

import type { CaptureFrame, CaptureFrameResult } from "./orb/routes.ts";

const CAPTURE_TIMEOUT_MS = 8_000;

type CaptureWindowSuccess = {
  image: string;
  format: "png";
};

/**
 * Build a `captureFrame` that pulls one window's capture from the shared daemon.
 *
 * The client is lazy: it connects on the first pull and reuses the connection
 * until it drops, at which point the next pull reconnects — a daemon that
 * restarts between frames is recovered, not fatal.
 */
export function createDesktopCapture(socketPath: string = daemonSocketPath()): CaptureFrame {
  const client = new DesktopClient({ socketPath });

  return async function captureFrame(windowId: string): Promise<CaptureFrameResult> {
    let result: CaptureWindowSuccess;
    try {
      result = await client.request<CaptureWindowSuccess>(
        "captureWindow",
        { windowId },
        CAPTURE_TIMEOUT_MS,
      );
    } catch (error) {
      // APPLICATION_NOT_FOUND is how a policy-blocked app and a gone window
      // both look to the hub. The daemon already enforced capture_refusal
      // before any pixels — the hub does not duplicate the check, it reads the
      // outcome. Both mean no frame, never a redacted one.
      if (error instanceof DesktopServiceError && error.code === "APPLICATION_NOT_FOUND") {
        return { refused: true, reason: "No frame available for this window." };
      }
      throw error;
    }
    return { refused: false, image: result.image, format: "png" };
  };
}
