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
