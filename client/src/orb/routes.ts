/**
 * What the orb page may ask the hub, now that the hub is deaf.
 *
 * The microphone, the wake gate, and the realtime session all live on client
 * devices; what remains here is the part a page still needs from the process
 * that outlives it: a status poll, the event stream, and the old gesture
 * vocabulary. The routes survive under their old names because faces depend
 * on them — what changed is what the hub can honestly say through them.
 *
 * Status is deliberately coarse — enabled, idle-or-talking, a count of open
 * mouths — while the event stream stays rich. A poll endpoint and a live
 * stream at different granularities is the intended split, not a bug to
 * reconcile: the poll answers "is this worth drawing", the stream carries the
 * conversation.
 */

import { Hono } from "hono";

import type { StateEvent } from "../events/types.ts";

export const ORB_BASE_PATH = "/api/orb";

/** Everything a face may send. Anything else is not a gesture. */
export const GESTURES = ["toggle", "mute", "dismiss"] as const;
export type Gesture = (typeof GESTURES)[number];

export function parseGesture(value: unknown): Gesture | undefined {
  return typeof value === "string" && (GESTURES as readonly string[]).includes(value)
    ? (value as Gesture)
    : undefined;
}

/** The render states the orb page knows. The SSE speaks only these. */
export type OrbState = "idle" | "listening" | "thinking" | "speaking";

/** What crosses the SSE to the orb page: states and captions, nothing else. */
export type OrbEvent = { type: "state"; state: OrbState } | { type: "caption"; text: string };

/**
 * The hub's side of the orb, since the retirement: how many mouths are open,
 * and the derived face events to stream. Both come from the lane — there is
 * nothing else left that knows anything about voice.
 */
export type OrbMount = {
  /** Open voice sessions on the lane right now. */
  mouths(): number;
  /** Subscribe to the derived face events (states and captions). */
  subscribe(listener: (event: StateEvent) => void): () => void;
  /**
   * Pull one frame of a window's pixels from the desktop daemon, policy-gated.
   * Absent when the hub has no read path to the daemon (a test, or a hub with
   * no desktop). The daemon enforces capture_refusal before any pixels, so a
   * blocked app surfaces here as a refusal — never a redacted frame.
   */
  captureFrame?: CaptureFrame;
};

/**
 * One pull of a window's capture: either the frame's pixels (base64 PNG, as the
 * daemon returns it) or a refusal naming why no pixels will come. Refusal is how
 * a policy-blocked app and a window that is gone look to the hub — both mean no
 * frame, and the hub neither can nor needs to tell them apart.
 */
export type CaptureFrameResult =
  | { refused: false; image: string; format: "png" }
  | { refused: true; reason: string };

export type CaptureFrame = (windowId: string) => Promise<CaptureFrameResult>;

export type OrbStatus =
  | { enabled: true; state: "idle" | "talking"; mouths: number }
  | { enabled: false; reason: string };

/**
 * Translate one face event into the page's vocabulary, or nothing.
 *
 * The mirror of the adapter that used to point the other way. Words the page
 * has no rendering for — progress, answer, the voice set transitions beyond
 * what wake_opened/idle already said, the touch lane — produce no frame:
 * a page told a word it cannot draw would guess, and a face that guesses is
 * showing something the hub never said.
 */
export function toPageEvent(event: StateEvent): OrbEvent | undefined {
  switch (event.type) {
    case "wake_opened":
      return { type: "state", state: "listening" };
    case "thinking":
      return { type: "state", state: "thinking" };
    case "speaking":
      return { type: "state", state: "speaking" };
    case "idle":
      return { type: "state", state: "idle" };
    case "caption":
      return { type: "caption", text: event.text };
    default:
      return undefined;
  }
}

/** MJPEG frame cap: ~5 frames per second. Latency over fidelity for v1. */
const FRAME_INTERVAL_MS = 200;
/** The multipart boundary separating streamed frames. */
const STREAM_BOUNDARY = "orbstream";

export function buildOrbApp(mount: OrbMount | { reason: string }): Hono {
  const app = new Hono();
  // At most one stream is live at a time; a new request replaces the active one.
  let stopActive: (() => void) | undefined;

  app.get(`${ORB_BASE_PATH}/status`, (c) => {
    if (!("mouths" in mount)) {
      return c.json<OrbStatus>({ enabled: false, reason: mount.reason });
    }
    const mouths = mount.mouths();
    return c.json<OrbStatus>({
      enabled: true,
      state: mouths > 0 ? "talking" : "idle",
      mouths,
    });
  });

  app.post(`${ORB_BASE_PATH}/gesture`, async (c) => {
    if (!("mouths" in mount)) return c.json({ error: mount.reason }, 400);

    const body = await c.req.json().catch(() => undefined);
    const gesture = parseGesture((body as { gesture?: unknown } | undefined)?.gesture);
    if (!gesture) {
      // Named refusal rather than a silent no-op: a face that sent something
      // unrecognised should learn that, not be quietly humoured.
      return c.json({ error: `Unknown gesture. This hub accepts: ${GESTURES.join(", ")}.` }, 400);
    }

    // The vocabulary survives; the gate it used to pull does not. Toggle once
    // opened the hub's wake gate by hand, mute and dismiss closed it — all
    // three now describe hardware the hub no longer holds. They are accepted
    // (a face depends on the route answering) and change nothing, and the
    // answer is the same truth the status route tells.
    return c.json({ state: mount.mouths() > 0 ? "talking" : "idle" });
  });

  /**
   * The event stream every SSE face reads.
   *
   * Server-sent events rather than a WebSocket: the traffic is one-directional
   * (gestures come back over the POST above), and SSE reconnects by itself,
   * which matters for a face that is allowed to disappear.
   */
  app.get(`${ORB_BASE_PATH}/events`, (c) => {
    if (!("mouths" in mount)) return c.json({ error: mount.reason }, 400);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: OrbEvent) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        // The opening frame is the current truth: a page joining a live
        // conversation should not sit on idle until the next word happens.
        send({ type: "state", state: mount.mouths() > 0 ? "listening" : "idle" });
        const unsubscribe = mount.subscribe((event) => {
          const pageEvent = toPageEvent(event);
          if (pageEvent) send(pageEvent);
        });
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

  /**
   * The live window stream: multipart/x-mixed-replace MJPEG, one window's
   * daemon capture repeated at a low frame cap while the page watches.
   *
   * The hub has no path to call captureWindow on demand until this route; the
   * stream is that path, read-only and policy-gated. The daemon enforces
   * capture_refusal before any pixels, so the hub does not duplicate the check
   * — a blocked app surfaces as a refusal, the same shape a gone window takes.
   *
   * Single-stream: the active work window is the only one worth watching, so a
   * new request replaces whatever is open. Latency over fidelity for v1: a low
   * frame cap, not a signalling server.
   */
  app.get(`${ORB_BASE_PATH}/stream/:windowId`, async (c) => {
    if (!("mouths" in mount)) return c.json({ error: mount.reason }, 403);
    const captureFrame = mount.captureFrame;
    if (!captureFrame) {
      return c.json({ error: "No desktop capture available on this hub." }, 404);
    }

    const windowId = c.req.param("windowId");

    // capture_refusal at the door: the first pull decides whether the window's
    // app may be seen at all, before a single multipart header is sent. A
    // blocked app yields no frame, never a redacted one.
    let first: CaptureFrameResult;
    try {
      first = await captureFrame(windowId);
    } catch {
      return c.json({ error: "The desktop service is unavailable." }, 503);
    }
    if (first.refused) return c.json({ error: first.reason }, 403);

    // A new viewer replaces the active one — the active work window is the only
    // one worth watching.
    stopActive?.();

    const openingImage = first.image;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const writeFrame = (image: string) => {
          if (stopped) return;
          const bytes = Buffer.from(image, "base64");
          try {
            controller.enqueue(
              encoder.encode(
                `\r\n--${STREAM_BOUNDARY}\r\nContent-Type: image/png\r\nContent-Length: ${bytes.length}\r\n\r\n`,
              ),
            );
            controller.enqueue(new Uint8Array(bytes));
          } catch {
            // The consumer has gone (closed or cancelled the stream). Stop the
            // frame loop so no further pull races a dead controller.
            stop();
          }
        };

        const stop = () => {
          if (stopped) return;
          stopped = true;
          if (timer !== undefined) clearTimeout(timer);
          try {
            controller.close();
          } catch {
            /* a stream closed twice is closed */
          }
        };

        stopActive = stop;
        c.req.raw.signal.addEventListener("abort", stop);

        // The frame that passed the door is the opening frame.
        writeFrame(openingImage);

        const pull = async () => {
          if (stopped) return;
          let next: CaptureFrameResult;
          try {
            next = await captureFrame(windowId);
          } catch {
            stop();
            return;
          }
          if (stopped) return;
          if (next.refused) {
            // A refusal mid-stream closes the stream cleanly — never a redacted
            // frame. The app was blocked or the window went away.
            stop();
            return;
          }
          writeFrame(next.image);
          timer = setTimeout(pull, FRAME_INTERVAL_MS);
        };
        timer = setTimeout(pull, FRAME_INTERVAL_MS);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": `multipart/x-mixed-replace; boundary=${STREAM_BOUNDARY}`,
        "cache-control": "no-cache",
        connection: "close",
      },
    });
  });

  return app;
}
