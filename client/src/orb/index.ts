/**
 * The orb's hub side, assembled and mounted — and deaf by design.
 *
 * Since the client migration, every microphone and every speaker lives on a
 * client device: the orb page's tap-to-talk mouth, the widget's tray-resident
 * ears. What the hub still owns is what only the hub can own — the token mint
 * (the Google key never leaves this process), the realtime settings file, the
 * status route, and the face events derived from the lane. There is no audio
 * capture here, no playback, no wake gate, and no realtime session: a device
 * that wants to talk mints a token and dials Google itself.
 *
 * The one refusal left is the one a person can fix: no Google credential
 * means no orb, said in the same sentence the mint uses.
 */

import { Hono } from "hono";

import type { StateEvent } from "../events/types.ts";
import { isRefusal, resolveOrbCredential } from "./credentials.ts";
import { buildRealtimeSettingsApp } from "./realtime-settings.ts";
import { buildTokenMintApp } from "./token-mint.ts";
import { buildOrbApp } from "./routes.ts";
import type { CaptureFrame } from "./routes.ts";

export { ORB_BASE_PATH, GESTURES, parseGesture, buildOrbApp, toPageEvent } from "./routes.ts";
export { GOOGLE_PROVIDER_ID, resolveOrbCredential, orbAvailability } from "./credentials.ts";
export { createHubBrain } from "./brain.ts";
export { createLaneFaceSource } from "./face-source.ts";

export type { OrbEvent, OrbState, OrbStatus, CaptureFrame, CaptureFrameResult } from "./routes.ts";
export type { HubBrain } from "./brain.ts";
export type { LaneFaceSource } from "./face-source.ts";

export type OrbMountOptions = {
  credentials: Parameters<typeof resolveOrbCredential>[0];
  /**
   * Path to the shared settings.json. When present, the realtime model and
   * voice settings route is mounted on the orb app — even when the orb itself
   * is refused, because the settings are machine facts, not session state.
   */
  settingsPath?: string;
  /**
   * The lane's view of the conversation: how many mouths are open, and the
   * derived face events. Absent in tests that only exercise the routes'
   * refusal arm.
   */
  faces?: {
    mouths(): number;
    subscribe(listener: (event: StateEvent) => void): () => void;
  };
  /**
   * A read path to the desktop daemon's window capture, policy-gated. Absent
   * when the hub has no desktop; present, the orb's stream route pulls frames
   * from it. Provided by the hub, not imported inside this pure module, so the
   * route stays unit-testable with a stub.
   */
  captureFrame?: CaptureFrame;
};

export type OrbMount = {
  app: Hono;
  /** Why the orb is off, when it is. Surfaced by health the way voice's is. */
  reason?: string;
};

/**
 * Build the orb's hub side, or explain why there isn't one.
 *
 * "Enabled" now means the mint and the lane are ready — nothing more. The
 * credential is the only question left to ask at mount time; the provider and
 * the ear chain were the devices' problems to solve, and they solved them.
 */
export async function mountOrb(options: OrbMountOptions): Promise<OrbMount> {
  // The settings and mint routes are mounted unconditionally — they work even
  // when the orb is refused. Settings are machine facts, not session state;
  // and the mint resolves the credential per request, so a person can paste a
  // key and wire a client without a hub restart. A hub with no credential
  // still answers, with the one sentence that says what to fix.
  const composeSettings = (app: Hono): Hono => {
    if (options.settingsPath) app.route("/", buildRealtimeSettingsApp(options.settingsPath));
    app.route(
      "/",
      buildTokenMintApp({
        credentials: options.credentials,
        ...(options.settingsPath !== undefined ? { settingsPath: options.settingsPath } : {}),
      }),
    );
    return app;
  };

  const credential = await resolveOrbCredential(options.credentials);
  if (isRefusal(credential)) {
    return {
      app: composeSettings(buildOrbApp({ reason: credential.reason })),
      reason: credential.reason,
    };
  }

  const faces = options.faces ?? { mouths: () => 0, subscribe: () => () => {} };
  return {
    app: composeSettings(
      buildOrbApp({
        mouths: () => faces.mouths(),
        subscribe: (listener) => faces.subscribe(listener),
        ...(options.captureFrame ? { captureFrame: options.captureFrame } : {}),
      }),
    ),
  };
}
