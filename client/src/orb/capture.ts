/**
 * The face photographs itself, and the hub hands the picture on.
 *
 * An agent asking "what does the orb look like right now" has, until now, had
 * exactly one honest answer available to it: grab the screen. That answer is
 * the one this product spends a whole test file refusing — a process that can
 * read the desktop is a keylogger with a nice animation, whatever it says it
 * wanted the pixels for. So the picture is taken by the only process entitled
 * to it: the widget's own shell, photographing its own window, through
 * Electron's `webContents.capturePage`. Nothing here asks the desktop for
 * anything.
 *
 * The round trip is deliberately split across two transports:
 *
 *   the ask    — a `capture_request` on the event lane, carrying an id
 *   the answer — a POST of raw PNG bytes to this hub, over loopback
 *
 * The lane carries intent and never content; that is the property the whole
 * socket is built around, and a base64 image riding a state event would end
 * it. It would also not work: the lane refuses binary frames unread and hangs
 * up a face buffering more than a megabyte, and a screenshot is bigger than
 * everything else the lane says all day, put together.
 *
 * A request that nobody answers expires. There is no queue, no retry, and no
 * stored image: the picture exists for exactly as long as the HTTP request
 * that asked for it, because a hub that kept photographs of a person's face
 * would be a hub that has a photograph of a person's screen corner on disk.
 */

import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

import { isLocalPeer } from "../events/socket.ts";
import type { EventSource } from "../events/source.ts";
import type { StateEvent } from "../events/types.ts";
import { ORB_BASE_PATH } from "./routes.ts";

/** Where an agent asks for the picture. */
export const CAPTURE_PATH = `${ORB_BASE_PATH}/capture`;

/**
 * How long a face has to answer.
 *
 * Long enough for a shell to composite a frame and push it over loopback,
 * short enough that a caller holding the request open is not left wondering.
 * A widget that has not answered in two seconds is not slow, it is absent —
 * hidden, disabled, or not running — and the honest reply is to say so.
 */
export const CAPTURE_TIMEOUT_MS = 2_000;

/**
 * The most PNG this hub will read from a face.
 *
 * A whole 4K stage at 32bpp compresses well under this; the ceiling exists so
 * a caller that is not a widget cannot make the hub hold an arbitrary amount
 * of memory by claiming to be one.
 */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

/** What an unanswerable id gets — unknown, expired, and already-answered alike. */
export const NO_SUCH_REQUEST = "No capture was waiting under that id.";

/** What a caller gets when no face answered in time. */
export const NO_FACE_ANSWERED = "No face answered within two seconds.";

export type CaptureRequests = {
  /** The lane side: `capture_request` events go out through this. */
  source: EventSource;
  /** Ask every attached face for a picture. Resolves undefined if none arrives. */
  request(): Promise<Uint8Array | undefined>;
  /** A face's answer. False when the id is not one this hub is waiting on. */
  answer(id: string, png: Uint8Array): boolean;
};

export type CaptureRequestOptions = {
  timeoutMs?: number;
  /** Injectable so a test can name the id it is about to answer under. */
  newId?: () => string;
};

export function createCaptureRequests(options: CaptureRequestOptions = {}): CaptureRequests {
  const timeoutMs = options.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const handlers = new Set<(event: StateEvent) => void>();
  const pending = new Map<string, (png: Uint8Array | undefined) => void>();

  return {
    source: {
      subscribe(handler) {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    },

    request() {
      const id = newId();
      return new Promise<Uint8Array | undefined>((resolve) => {
        // Settled exactly once, whichever arrives first. The entry is removed
        // before resolving so a second answer under the same id finds nothing
        // waiting — an answered request is as gone as an expired one, and a
        // caller cannot tell the two apart.
        const settle = (png: Uint8Array | undefined) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          resolve(png);
        };
        const timer = setTimeout(() => settle(undefined), timeoutMs);
        // Node keeps the process alive for a pending timer; a two-second
        // window on a request nobody made should not be what holds a hub open
        // during shutdown.
        timer.unref?.();
        pending.set(id, settle);
        for (const handler of [...handlers]) handler({ type: "capture_request", id });
      });
    },

    answer(id, png) {
      const settle = pending.get(id);
      if (!settle) return false;
      settle(png);
      return true;
    },
  };
}

export function buildCaptureApp(mount: { requests: CaptureRequests }): Hono {
  const app = new Hono();

  app.get(CAPTURE_PATH, async (c) => {
    const png = await mount.requests.request();
    if (!png) return c.json({ error: NO_FACE_ANSWERED }, 504);
    return new Response(bytesOf(png), {
      status: 200,
      headers: {
        "content-type": "image/png",
        // The picture is this instant's, and this instant's only.
        "cache-control": "no-store",
      },
    });
  });

  app.post(`${CAPTURE_PATH}/:id`, async (c) => {
    // The kernel's account of the peer, never a header — the same check the
    // `/events` door and the pairing routes make, through the same helper, so
    // the three places that decide "is this the machine itself" cannot drift.
    if (!local(c)) return c.json({ error: NO_SUCH_REQUEST }, 404);

    const body = await c.req.arrayBuffer().catch(() => undefined);
    if (!body || body.byteLength === 0 || body.byteLength > MAX_CAPTURE_BYTES) {
      return c.json({ error: NO_SUCH_REQUEST }, 404);
    }

    // One refusal shape for every reason a POST can fail: an unknown id, an
    // expired one, an id already answered, a body that is not a picture. A
    // caller that could tell them apart could walk the id space one refusal
    // at a time, and the ids are the only thing standing between a stranger
    // on loopback and a picture of somebody's desktop corner.
    if (!isPng(body)) return c.json({ error: NO_SUCH_REQUEST }, 404);
    if (!mount.requests.answer(c.req.param("id"), new Uint8Array(body))) {
      return c.json({ error: NO_SUCH_REQUEST }, 404);
    }
    return c.body(null, 204);
  });

  return app;
}

/**
 * The picture as a body a `Response` will take.
 *
 * `slice()` rather than `.buffer` because a view is not its buffer: a
 * `Uint8Array` may sit at an offset inside a larger allocation, and handing
 * the whole allocation to the network would send bytes that are not part of
 * the picture.
 */
function bytesOf(png: Uint8Array): ArrayBuffer {
  return png.slice().buffer as ArrayBuffer;
}

/** The eight bytes every PNG starts with, and nothing else does. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(body: ArrayBuffer): boolean {
  if (body.byteLength < PNG_MAGIC.length) return false;
  const head = new Uint8Array(body, 0, PNG_MAGIC.length);
  return PNG_MAGIC.every((byte, index) => head[index] === byte);
}

function local(c: Context): boolean {
  try {
    return isLocalPeer(getConnInfo(c).remote.address);
  } catch {
    // No connection info is not a claim of locality.
    return false;
  }
}
