/**
 * The self-capture round trip, asserted from both ends.
 *
 * The properties under test are the ones that decide whether this route is
 * safe to ship: the ask carries an id and nothing else, the answer comes back
 * over loopback and only over loopback, an id is answerable exactly once, and
 * every unanswerable id is refused in one indistinguishable shape so the id
 * space cannot be walked. A caller that could tell "expired" from "already
 * answered" from "never existed" could guess its way to somebody's face.
 */

import { describe, expect, it } from "vitest";

import type { StateEvent } from "../events/types.ts";
import {
  CAPTURE_PATH,
  MAX_CAPTURE_BYTES,
  NO_FACE_ANSWERED,
  NO_SUCH_REQUEST,
  buildCaptureApp,
  createCaptureRequests,
} from "./capture.ts";

/** The env shape `getConnInfo` reads: the kernel's account of the peer. */
const LOCAL = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const REMOTE = { incoming: { socket: { remoteAddress: "192.168.1.44" } } };

/** A minimal, real PNG header — the magic bytes and nothing after them. */
function png(...tail: number[]): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail]);
}

/** A well-formed PNG header on a body larger than this hub agrees to read. */
function oversizedPng(): Uint8Array {
  const body = new Uint8Array(MAX_CAPTURE_BYTES + 1);
  body.set(png());
  return body;
}

/** A face on the lane, remembering everything the hub said to it. */
function attachFace(requests: ReturnType<typeof createCaptureRequests>) {
  const heard: StateEvent[] = [];
  const unsubscribe = requests.source.subscribe((event) => heard.push(event));
  return { heard, unsubscribe };
}

function answer(app: ReturnType<typeof buildCaptureApp>, id: string, body: Uint8Array, env = LOCAL) {
  return app.request(
    `${CAPTURE_PATH}/${id}`,
    { method: "POST", body: body.slice().buffer as ArrayBuffer },
    env,
  );
}

describe("asking a face to photograph itself", () => {
  it("sends one capture_request carrying an id and nothing else", async () => {
    const requests = createCaptureRequests({ newId: () => "req-1" });
    const face = attachFace(requests);

    const picture = requests.request();
    expect(face.heard).toEqual([{ type: "capture_request", id: "req-1" }]);

    requests.answer("req-1", png(1, 2, 3));
    expect(await picture).toEqual(png(1, 2, 3));
  });

  it("serves the face's own bytes as a PNG", async () => {
    const requests = createCaptureRequests({ newId: () => "req-1" });
    const app = buildCaptureApp({ requests });
    requests.source.subscribe((event) => {
      // A face answers the moment it is asked, the way a shell that already
      // has a window would.
      if (event.type === "capture_request") requests.answer(event.id, png(7, 7, 7));
    });

    const response = await app.request(CAPTURE_PATH, {}, LOCAL);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png(7, 7, 7));
  });

  it("says plainly when no face answered, rather than hanging", async () => {
    const requests = createCaptureRequests({ timeoutMs: 5 });
    const app = buildCaptureApp({ requests });

    const response = await app.request(CAPTURE_PATH, {}, LOCAL);
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: NO_FACE_ANSWERED });
  });

  it("stops waiting for a face that never answers", async () => {
    const requests = createCaptureRequests({ timeoutMs: 5, newId: () => "req-1" });
    expect(await requests.request()).toBeUndefined();
    // The expired id is as gone as one that never existed.
    expect(requests.answer("req-1", png())).toBe(false);
  });

  it("keeps no handler for a face that walked away", () => {
    const requests = createCaptureRequests({ timeoutMs: 5, newId: () => "req-1" });
    const face = attachFace(requests);
    face.unsubscribe();
    void requests.request();
    expect(face.heard).toEqual([]);
  });
});

describe("the answer comes back over loopback, once", () => {
  it("refuses a stranger's picture without telling him why", async () => {
    const requests = createCaptureRequests({ newId: () => "req-1" });
    const app = buildCaptureApp({ requests });
    const picture = requests.request();

    const refused = await answer(app, "req-1", png(1), REMOTE);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: NO_SUCH_REQUEST });

    // The request is still open: a stranger's failed POST must not consume the
    // answer the real face is about to give.
    expect((await answer(app, "req-1", png(2))).status).toBe(204);
    expect(await picture).toEqual(png(2));
  });

  it("answers an id exactly once", async () => {
    const requests = createCaptureRequests({ newId: () => "req-1" });
    const app = buildCaptureApp({ requests });
    const picture = requests.request();

    expect((await answer(app, "req-1", png(1))).status).toBe(204);
    expect(await picture).toEqual(png(1));

    const second = await answer(app, "req-1", png(2));
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: NO_SUCH_REQUEST });
  });

  it("refuses every unanswerable id in one shape", async () => {
    const requests = createCaptureRequests({ newId: () => "req-1" });
    const app = buildCaptureApp({ requests });
    void requests.request();

    const refusals = await Promise.all([
      // An id nobody is waiting on.
      answer(app, "req-2", png(1)),
      // A body that is not a picture, under an id that is real.
      answer(app, "req-1", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
      // Nothing at all, under an id that is real.
      answer(app, "req-1", new Uint8Array()),
      // More than this hub will read, under an id that is real.
      answer(app, "req-1", oversizedPng()),
    ]);

    for (const refusal of refusals) {
      expect(refusal.status).toBe(404);
      expect(await refusal.json()).toEqual({ error: NO_SUCH_REQUEST });
    }
  });
});
