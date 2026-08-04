/**
 * What a face is allowed to ask the hub, and nothing more.
 *
 * The orb page is a renderer. It does not hold the microphone, the credential,
 * the realtime socket, or the gate — those live in this process, per #107, so
 * that the privacy property is enforced in one place and survives any face being
 * closed. What crosses this boundary is therefore small on purpose: state and
 * captions go out, gestures come in.
 *
 * The vocabulary is closed at both ends. A gesture the hub does not name is
 * refused rather than ignored, because a face that can send an unrecognised
 * message is a face that can be extended into something with more reach than a
 * renderer — and the same socket is what the widget in #107 will ride.
 */

import { Hono } from "hono";

import type { Orb, OrbEvent, OrbState } from "./orb.ts";

export const ORB_BASE_PATH = "/api/orb";

/** Everything a face may send. Anything else is not a gesture. */
export const GESTURES = ["toggle", "mute", "dismiss"] as const;
export type Gesture = (typeof GESTURES)[number];

export function parseGesture(value: unknown): Gesture | undefined {
  return typeof value === "string" && (GESTURES as readonly string[]).includes(value)
    ? (value as Gesture)
    : undefined;
}

export type OrbMount = {
  orb: Orb;
  /** Absent when there is no Google credential; the page says why. */
  reason?: string;
  /** Subscribe a face to the event stream. Returns an unsubscribe. */
  subscribe(listener: (event: OrbEvent) => void): () => void;
};

export type OrbStatus =
  | { enabled: true; state: OrbState; gate: string; languages: readonly string[] }
  | { enabled: false; reason: string };

export function buildOrbApp(mount: OrbMount | { reason: string }): Hono {
  const app = new Hono();

  app.get(`${ORB_BASE_PATH}/status`, (c) => {
    if (!("orb" in mount)) {
      return c.json<OrbStatus>({ enabled: false, reason: mount.reason });
    }
    return c.json<OrbStatus>({
      enabled: true,
      state: mount.orb.state,
      gate: mount.orb.gateState,
      languages: mount.orb.languages,
    });
  });

  app.post(`${ORB_BASE_PATH}/gesture`, async (c) => {
    if (!("orb" in mount)) return c.json({ error: mount.reason }, 400);

    const body = await c.req.json().catch(() => undefined);
    const gesture = parseGesture((body as { gesture?: unknown } | undefined)?.gesture);
    if (!gesture) {
      // Named refusal rather than a silent no-op: a face that sent something
      // unrecognised should learn that, not be quietly humoured.
      return c.json({ error: `Unknown gesture. This hub accepts: ${GESTURES.join(", ")}.` }, 400);
    }

    switch (gesture) {
      case "toggle":
        mount.orb.toggle();
        break;
      case "mute":
      case "dismiss":
        mount.orb.closeGate();
        break;
    }
    return c.json({ state: mount.orb.state, gate: mount.orb.gateState });
  });

  /**
   * The event stream every face reads.
   *
   * Server-sent events rather than a WebSocket: the traffic is one-directional
   * (gestures come back over the POST above), and SSE reconnects by itself,
   * which matters for a face that is allowed to disappear.
   */
  app.get(`${ORB_BASE_PATH}/events`, (c) => {
    if (!("orb" in mount)) return c.json({ error: mount.reason }, 400);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: OrbEvent) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        send({ type: "state", state: mount.orb.state });
        const unsubscribe = mount.subscribe(send);
        c.req.raw.signal.addEventListener("abort", () => {
          unsubscribe();
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });

  return app;
}
