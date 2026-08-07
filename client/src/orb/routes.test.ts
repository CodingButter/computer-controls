import { describe, expect, it } from "vitest";

import type { StateEvent } from "../events/types.ts";
import { GESTURES, buildOrbApp, parseGesture, toPageEvent } from "./routes.ts";

/**
 * The routes survive the hub going deaf under their old names — a face
 * depends on them — so these tests pin what the hub can still honestly say
 * through them: a coarse status derived from the lane's mouth count, an SSE
 * stream of derived states and captions, and a gesture vocabulary that is
 * accepted and truthfully changes nothing.
 */

type Listener = (event: StateEvent) => void;

function liveMount(mouths = 0) {
  const listeners = new Set<Listener>();
  const state = { mouths };
  return {
    mount: {
      mouths: () => state.mouths,
      subscribe(listener: Listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit: (event: StateEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
    listeners,
    state,
  };
}

describe("the status a poll can trust", () => {
  it("no open mouths is idle", async () => {
    const { mount } = liveMount(0);
    const res = await buildOrbApp(mount).request("/api/orb/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, state: "idle", mouths: 0 });
  });

  it("any open mouth is talking, and the count says how many", async () => {
    const { mount } = liveMount(2);
    const res = await buildOrbApp(mount).request("/api/orb/status");

    expect(await res.json()).toEqual({ enabled: true, state: "talking", mouths: 2 });
  });

  it("a refused orb answers with the reason, not a fake green", async () => {
    const res = await buildOrbApp({ reason: "The orb needs a Google account." }).request(
      "/api/orb/status",
    );

    expect(await res.json()).toEqual({
      enabled: false,
      reason: "The orb needs a Google account.",
    });
  });
});

describe("the gesture vocabulary, still closed", () => {
  it("names exactly the three words a face may send", () => {
    expect(GESTURES).toEqual(["toggle", "mute", "dismiss"]);
    expect(parseGesture("toggle")).toBe("toggle");
    expect(parseGesture("explode")).toBeUndefined();
    expect(parseGesture(42)).toBeUndefined();
  });

  it("accepts a known gesture and answers the same truth status tells", async () => {
    const { mount } = liveMount(1);
    const res = await buildOrbApp(mount).request("/api/orb/gesture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gesture: "mute" }),
    });

    // The gate these words used to pull lives on the devices now. The route
    // answers — a face depends on that — and changes nothing.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "talking" });
  });

  it("refuses an unknown gesture by name", async () => {
    const { mount } = liveMount(0);
    const res = await buildOrbApp(mount).request("/api/orb/gesture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gesture: "restart" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Unknown gesture. This hub accepts: toggle, mute, dismiss.",
    );
  });
});

describe("what a face event means for the page", () => {
  it("translates the words the page can draw", () => {
    expect(toPageEvent({ type: "wake_opened" })).toEqual({ type: "state", state: "listening" });
    expect(toPageEvent({ type: "thinking" })).toEqual({ type: "state", state: "thinking" });
    expect(toPageEvent({ type: "speaking" })).toEqual({ type: "state", state: "speaking" });
    expect(toPageEvent({ type: "idle" })).toEqual({ type: "state", state: "idle" });
    expect(toPageEvent({ type: "caption", text: "hi" })).toEqual({ type: "caption", text: "hi" });
  });

  it("stays silent for words the page has no rendering for", () => {
    expect(toPageEvent({ type: "voice_opened" })).toBeUndefined();
    expect(toPageEvent({ type: "voice_closed" })).toBeUndefined();
    expect(toPageEvent({ type: "progress", id: "a", text: "…" })).toBeUndefined();
    expect(toPageEvent({ type: "answer", id: "a", text: "done" })).toBeUndefined();
  });
});

describe("the stream a page actually reads", () => {
  async function frames(res: Response, expected: number): Promise<unknown[]> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while ((text.match(/\n\n/g) ?? []).length < expected) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    return text
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice("data: ".length)));
  }

  it("opens with the current truth and then carries the conversation", async () => {
    const live = liveMount(0);
    const app = buildOrbApp(live.mount);

    const res = await app.request("/api/orb/events");
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    live.state.mouths = 1;
    live.emit({ type: "wake_opened" });
    live.emit({ type: "caption", text: "hello there" });
    // A lane word the page cannot draw crosses the subscription silently.
    live.emit({ type: "voice_opened" });
    live.emit({ type: "idle" });

    expect(await frames(res, 4)).toEqual([
      { type: "state", state: "idle" },
      { type: "state", state: "listening" },
      { type: "caption", text: "hello there" },
      { type: "state", state: "idle" },
    ]);
  });

  it("a page joining a live conversation does not sit on idle", async () => {
    const live = liveMount(1);
    const res = await buildOrbApp(live.mount).request("/api/orb/events");

    expect(await frames(res, 1)).toEqual([{ type: "state", state: "listening" }]);
  });

  it("a refused orb refuses the stream with the reason", async () => {
    const res = await buildOrbApp({ reason: "The orb needs a Google account." }).request(
      "/api/orb/events",
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("The orb needs a Google account.");
  });
});

/**
 * The MJPEG stream route: the hub's read path to a single window's daemon
 * capture, repeated at a low frame cap while the page watches. These tests pin
 * the contract that matters for a policy-gated live stream — the door refuses
 * before any pixels, the stream emits correctly-framed parts while it runs, a
 * mid-stream refusal closes cleanly without a redacted frame, and a new viewer
 * replaces the active one.
 */

/** A tiny 1×1 PNG, base64. Enough to prove framing is byte-accurate. */
const PNG_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_PIXEL, "base64"));

/** A second distinct payload, so a test can tell two frames apart. */
const PNG_ALT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwAEoA/BC+0PAAAAAElFTkSuQmCC";
const PNG_ALT_BYTES = new Uint8Array(Buffer.from(PNG_ALT, "base64"));

function captureMount(captureFrame: (windowId: string) => Promise<unknown>) {
  const live = liveMount(0);
  return { ...live, mount: { ...live.mount, captureFrame: captureFrame as never } };
}

/**
 * Read the raw bytes of a stream response until at least `partCount`
 * multipart boundaries have arrived (or the stream ends), then return the
 * individual image part payloads parsed from the boundary delimiters.
 *
 * Works entirely in raw bytes — the image payloads are PNG binary, so a
 * text decode/encode round-trip would corrupt non-ASCII bytes.
 */
const BOUNDARY = new TextEncoder().encode("--orbstream");
const HEADER_SEP = new TextEncoder().encode("\r\n\r\n");

async function streamParts(res: Response, partCount: number): Promise<Uint8Array[]> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let boundaryHits = 0;
  while (boundaryHits < partCount) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    boundaryHits += countBytes(value, BOUNDARY);
  }
  await reader.cancel();
  return splitParts(concat(chunks));
}

function countBytes(haystack: Uint8Array, needle: Uint8Array): number {
  let count = 0;
  let i = 0;
  while ((i = indexOfBytes(haystack, needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Split a multipart/x-mixed-replace body into its image part payloads (raw bytes). */
function splitParts(body: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let search = 0;
  while (true) {
    const boundaryAt = indexOfBytes(body, BOUNDARY, search);
    if (boundaryAt === -1) break;
    const nextBoundary = indexOfBytes(body, BOUNDARY, boundaryAt + BOUNDARY.length);
    const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
    const headerSep = indexOfBytes(body, HEADER_SEP, boundaryAt);
    if (headerSep !== -1 && headerSep < partEnd) {
      let payloadStart = headerSep + HEADER_SEP.length;
      let payloadEnd = partEnd;
      // Trim the \r\n that precedes the next boundary delimiter.
      if (payloadEnd >= 2 && body[payloadEnd - 2] === 0x0d && body[payloadEnd - 1] === 0x0a) {
        payloadEnd -= 2;
      }
      if (payloadEnd > payloadStart) {
        parts.push(body.slice(payloadStart, payloadEnd));
      }
    }
    search = boundaryAt + BOUNDARY.length;
  }
  return parts;
}

describe("the MJPEG window stream", () => {
  it("a hub without a capture path answers 404, not a broken stream", async () => {
    const { mount } = liveMount(0);
    const res = await buildOrbApp(mount).request("/api/orb/stream/win1");

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("No desktop capture available on this hub.");
  });

  it("a refused orb refuses the stream at the door", async () => {
    const res = await buildOrbApp({ reason: "The orb needs a Google account." }).request(
      "/api/orb/stream/win1",
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("The orb needs a Google account.");
  });

  it("a blocked window refuses at the door with no image parts ever sent", async () => {
    const captureFrame = async () => ({ refused: true, reason: "No frame available for this window." });
    const { mount } = captureMount(captureFrame);

    const res = await buildOrbApp(mount).request("/api/orb/stream/win1");

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("No frame available for this window.");
    // No multipart headers were ever committed — the refusal is plain JSON.
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("a capture error at the door answers 503, never a partial stream", async () => {
    const captureFrame = async () => {
      throw new Error("connection refused");
    };
    const { mount } = captureMount(captureFrame);

    const res = await buildOrbApp(mount).request("/api/orb/stream/win1");

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("The desktop service is unavailable.");
  });

  it("emits correctly-framed multipart PNG parts while the window is watchable", async () => {
    let calls = 0;
    const payloads = [PNG_PIXEL, PNG_ALT, PNG_PIXEL];
    const expectedBytes = [PNG_BYTES, PNG_ALT_BYTES, PNG_BYTES];
    const captureFrame = async (_windowId: string) => {
      const image = payloads[calls] ?? payloads[payloads.length - 1];
      calls++;
      return { refused: false, image, format: "png" as const };
    };
    const { mount } = captureMount(captureFrame);

    const res = await buildOrbApp(mount).request("/api/orb/stream/win1");

    expect(res.headers.get("content-type")).toBe("multipart/x-mixed-replace; boundary=orbstream");
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const parts = await streamParts(res, 3);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    // The opening frame is the first pull's image, before the interval loop.
    expect(parts[0]).toEqual(expectedBytes[0]);
    // Subsequent frames follow the capture sequence.
    expect(parts[1]).toEqual(expectedBytes[1]);
  });

  it("a mid-stream refusal closes the stream cleanly, never a redacted frame", async () => {
    let calls = 0;
    const captureFrame = async (_windowId: string) => {
      calls++;
      if (calls > 2) return { refused: true, reason: "blocked mid-stream" };
      return { refused: false, image: PNG_PIXEL, format: "png" as const };
    };
    const { mount } = captureMount(captureFrame);

    const res = await buildOrbApp(mount).request("/api/orb/stream/win1");
    const parts = await streamParts(res, 99);

    // Two frames (the door pull + one interval pull), then the refusal closes.
    expect(parts.length).toBe(2);
    expect(parts.every((p) => p.length > 0)).toBe(true);
    // The refusal reason never reaches the stream as image bytes.
    expect(Buffer.concat(parts).includes("blocked mid-stream")).toBe(false);
  });

  it("a new viewer replaces the active stream", async () => {
    const captureFrame = async (_windowId: string) => {
      return { refused: false, image: PNG_PIXEL, format: "png" as const };
    };
    const { mount } = captureMount(captureFrame);
    const app = buildOrbApp(mount);

    const first = await app.request("/api/orb/stream/win1");
    const firstReader = first.body!.getReader();
    // Confirm the first stream is live.
    const { done: openingDone } = await firstReader.read();
    expect(openingDone).toBe(false);

    // Open a second stream — the single-stream cap replaces the first.
    const second = await app.request("/api/orb/stream/win2");
    expect(second.headers.get("content-type")).toBe("multipart/x-mixed-replace; boundary=orbstream");

    // Drain the first stream; it must terminate because the cap closed it.
    let firstEnded = false;
    for (let i = 0; i < 100; i++) {
      const { done } = await firstReader.read();
      if (done) {
        firstEnded = true;
        break;
      }
    }
    expect(firstEnded).toBe(true);
    await second.body!.getReader().cancel();
  });

  it("passes the window id from the path to each capture pull", async () => {
    const seen: string[] = [];
    const captureFrame = async (windowId: string) => {
      seen.push(windowId);
      return { refused: false, image: PNG_PIXEL, format: "png" as const };
    };
    const { mount } = captureMount(captureFrame);

    const res = await buildOrbApp(mount).request("/api/orb/stream/special-window-42");
    await streamParts(res, 2);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((id) => id === "special-window-42")).toBe(true);
  });
});
