import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, test } from "vitest";
import WebSocket from "ws";

import { ScriptedEventSource } from "../../../client/src/events/source.ts";
import { attachEventSocket } from "../../../client/src/events/socket.ts";
import { combineEventSources } from "../../../client/src/events/touch-lane.ts";
import { buildCaptureApp, createCaptureRequests } from "../../../client/src/orb/capture.ts";
import { INITIAL_STATE, applyGesture, fade, reduce } from "./state-machine.js";
import { paintCaption } from "./paint.js";
import { captureRect, openingPlacement } from "./window-shape.js";

/**
 * A turn, from the hub's mouth to the widget's face.
 *
 * The pieces are tested apart elsewhere; this is the join. A real HTTP server
 * with the real socket attached on one side, the real widget modules on the
 * other, and a real WebSocket between them — the only thing standing in for
 * something is the ear, which is #105's work and deliberately not here.
 *
 * This runs in the ordinary lane rather than the gate lane, and that is a
 * deliberate reading of what the gate lane is for. Gate tests want a real model
 * provider and a real credential; this wants a loopback port. Making it a gate
 * test would mean the join between the hub and the face went unchecked on most
 * runs, which is exactly the seam most likely to break.
 */

let server: ReturnType<typeof serve>;
let source: ScriptedEventSource;
let captures: ReturnType<typeof createCaptureRequests>;
let socket: ReturnType<typeof attachEventSocket>;
let port: number;

beforeEach(async () => {
  source = new ScriptedEventSource();
  captures = createCaptureRequests();
  // The hub's own routes, not a stand-in: the capture round trip is half HTTP
  // and half socket, and a test that faked either half would be checking the
  // half it wrote.
  const app = buildCaptureApp({ requests: captures });
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  socket = attachEventSocket(server, combineEventSources(source, captures.source));
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  socket.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * A widget: the real modules, wired the way the renderer wires them.
 *
 * `shell` stands in for the one thing that cannot run here — Electron taking a
 * picture of its own window. Everything around it is real: the lane word, the
 * rectangle the real geometry helper computes, the loopback POST main makes,
 * and the hub route on the other end.
 */
function widget(shell?: { capturePage(rect: Rect): Uint8Array | undefined }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events`);
  let state = INITIAL_STATE;
  const painted = { textContent: "" };
  const captions: string[] = [];
  const photographed: Rect[] = [];

  ws.on("message", async (raw: Buffer) => {
    const event = JSON.parse(raw.toString());
    if (event.type === "capture_request" && shell) {
      const stage = openingPlacement(DISPLAY, "corner");
      const rect = captureRect(stage, stage);
      photographed.push(rect);
      const png = shell.capturePage(rect);
      if (png) {
        await fetch(`http://127.0.0.1:${port}/api/orb/capture/${event.id}`, {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: png.slice(),
        });
      }
    }
    state = reduce(state, event);
    paintCaption(painted, state.caption);
    captions.push(painted.textContent);
  });

  return {
    ws,
    opened: new Promise<void>((resolve) => ws.on("open", () => resolve())),
    get state() {
      return state;
    },
    get onScreen() {
      return painted.textContent;
    },
    captions,
    photographed,
    gesture(g: { type: string; x?: number; y?: number }) {
      state = applyGesture(state, g);
      ws.send(JSON.stringify(g));
    },
  };
}

/** Let everything in flight arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

type Rect = { x: number; y: number; width: number; height: number };

/** One ordinary monitor, so the geometry in the capture test is checkable by hand. */
const DISPLAY = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
};

/** The smallest thing that is a PNG as far as every reader is concerned. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

test("a turn: the face arrives when spoken to, says what was said, and fades", async () => {
  const face = widget();
  await face.opened;

  // Nothing has been said yet, so there is nothing on the desk.
  expect(face.state.presence).toBe("hidden");

  // Somebody speaks. The gate opens.
  source.emit({ type: "wake_opened" });
  await settle();
  expect(face.state.presence).toBe("visible");
  expect(face.state.activity).toBe("listening");

  // Their words appear under the orb, exactly as the hub heard them —
  // including the punctuation and the markup-shaped phrase, over a real
  // socket and a real JSON round trip.
  const said = 'remind me to email Dr. O\'Neill about the <urgent> thing & "the other one"';
  source.emit({ type: "caption", text: said });
  await settle();
  expect(face.onScreen).toBe(said);

  source.emit({ type: "thinking" });
  await settle();
  expect(face.state.activity).toBe("thinking");

  source.emit({ type: "speaking" });
  source.emit({ type: "caption", text: "I'll remind you at four." });
  await settle();
  expect(face.state.activity).toBe("speaking");
  expect(face.onScreen).toBe("I'll remind you at four.");

  // The turn ends: the face rests, with the answer still readable under it.
  source.emit({ type: "idle" });
  await settle();
  expect(face.state.presence).toBe("visible");
  expect(face.onScreen).toBe("I'll remind you at four.");

  // Then the auto-hide timer fires — the shell's transition, not a hub word,
  // which is why it is applied here rather than emitted — and the face fades
  // and takes the words with it.
  const faded = fade(face.state, true);
  expect(faded.presence).toBe("hidden");
  expect(faded.caption).toBe("");

  // Every caption that reached the screen was one the hub sent, unaltered.
  //
  // Deduplicated by consecutive run, because the words stay on screen while
  // the hub thinks and while it speaks — a caption that blinked out during the
  // pause between hearing and answering would be a worse face than one that
  // holds the sentence there. So the interesting sequence is which distinct
  // lines appeared, in order, not how many events redrew them.
  const distinct = face.captions.filter((line, i) => line !== face.captions[i - 1]);
  expect(distinct.filter(Boolean)).toEqual([said, "I'll remind you at four."]);

  face.ws.close();
});

test("what the agent is touching arrives over the socket and is drawn by nobody", async () => {
  // The widget no longer has a surface to point with: the window is the orb's
  // own box, so there is nothing wide enough to draw a rectangle over a control
  // on the other side of the desk. The words stay understood — they are the
  // hub's vocabulary and a successor surface is #177's work — so what this
  // pins is that the lane still carries them and the face still tracks them
  // honestly, gaining and losing nothing else.
  const face = widget();
  await face.opened;

  source.emit({ type: "wake_opened" });
  await settle();
  expect(face.state.scouts).toEqual([]);

  source.emit({ type: "touching", id: "call-1", x: 2400, y: 512, width: 96, height: 28 });
  source.emit({ type: "touching", id: "call-2", x: 200, y: 512, width: 96, height: 28 });
  await settle();

  // Both, in the coordinates the desktop reported. Nothing is dropped for being
  // on a monitor the window is not on, because the window is not a monitor.
  expect(face.state.scouts).toEqual([
    { id: "call-1", x: 2400, y: 512, width: 96, height: 28 },
    { id: "call-2", x: 200, y: 512, width: 96, height: 28 },
  ]);
  // The face itself is unmoved by the work: no caption invented, still visible.
  expect(face.onScreen).toBe("");
  expect(face.state.presence).toBe("visible");

  // The work finishes and the record goes with it.
  source.emit({ type: "released", id: "call-1" });
  source.emit({ type: "released", id: "call-2" });
  await settle();
  expect(face.state.scouts).toEqual([]);

  face.ws.close();
});

test("test_the_event_socket_carries_state_out_and_gestures_in_and_nothing_else", async () => {
  const face = widget();
  await face.opened;

  // Gestures go up and are understood.
  face.gesture({ type: "mute" });
  face.gesture({ type: "drag", x: 120, y: 640 });
  face.gesture({ type: "dismiss" });
  await settle();
  expect(source.received).toEqual([
    { type: "mute" },
    { type: "drag", x: 120, y: 640 },
    { type: "dismiss" },
  ]);

  // Anything else is dropped. These are the shapes a wider client would try:
  // a plausible-looking request, an audio frame, a command, a malformed
  // gesture. The socket's vocabulary is closed, so none of them arrive.
  face.ws.send(JSON.stringify({ type: "listen" }));
  face.ws.send(JSON.stringify({ type: "execute", command: "rm -rf ~" }));
  face.ws.send(JSON.stringify({ type: "drag", x: "over there" }));
  face.ws.send(JSON.stringify({ type: "caption", text: "a face does not caption" }));
  face.ws.send(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01]));
  face.ws.send("not json at all");
  await settle();

  expect(source.received).toHaveLength(3);

  // And the socket is still up: refusing a word is not a reason to hang up on
  // a face that is otherwise behaving.
  expect(face.ws.readyState).toBe(WebSocket.OPEN);
  source.emit({ type: "wake_opened" });
  await settle();
  expect(face.state.presence).toBe("visible");

  face.ws.close();
});

test("two faces watch the same conversation without knowing about each other", async () => {
  // The web orb page and the widget are two faces over one set of hub-owned
  // ears, which only works if the stream is a broadcast rather than a session.
  const first = widget();
  const second = widget();
  await Promise.all([first.opened, second.opened]);

  source.emit({ type: "wake_opened" });
  source.emit({ type: "caption", text: "the same words to both" });
  await settle();

  expect(first.onScreen).toBe("the same words to both");
  expect(second.onScreen).toBe("the same words to both");

  // One face leaving does not disturb the other, which is what makes a widget
  // dismissable while the orb page stays open.
  second.ws.close();
  await settle();
  source.emit({ type: "caption", text: "still listening" });
  await settle();
  expect(first.onScreen).toBe("still listening");

  first.ws.close();
});

test("the hub keeps talking after a face disappears mid-sentence", async () => {
  // A widget that crashes, or a laptop lid closing, must not take the hub with
  // it — the ears belong to the hub and outlive any face.
  const face = widget();
  await face.opened;
  source.emit({ type: "wake_opened" });
  await settle();

  face.ws.terminate();
  await settle();

  expect(() => {
    source.emit({ type: "caption", text: "into an empty room" });
    source.emit({ type: "idle" });
  }).not.toThrow();

  // And a new face joins the conversation already in progress.
  const replacement = widget();
  await replacement.opened;
  source.emit({ type: "caption", text: "back again" });
  await settle();
  expect(replacement.state.presence).toBe("visible");
  expect(replacement.onScreen).toBe("back again");

  replacement.ws.close();
});

test("an agent asks what the face looks like and gets the face's own pixels", async () => {
  const face = widget({ capturePage: () => PNG });
  await face.opened;
  source.emit({ type: "wake_opened" });
  await settle();

  const response = await fetch(`http://127.0.0.1:${port}/api/orb/capture`);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);

  // The rectangle the face was asked for is the orb's box, stated in the
  // window's own coordinates. This is the whole security claim of the lane,
  // checked end to end: the window is the face now, so the picture is the
  // 360x260 the face occupies and nothing of the 1920x1080 desk behind it.
  expect(face.photographed).toEqual([{ x: 0, y: 0, width: 360, height: 260 }]);

  // And being photographed changed nothing about what is drawn.
  expect(face.state.activity).toBe("listening");
  expect(face.onScreen).toBe("");

  face.ws.close();
});

test("nobody is watching, so the hub says so instead of waiting forever", async () => {
  // No face attached at all. A request that hung would be worse than a refusal:
  // an agent waiting on a widget that is not running has no way to find out.
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/api/orb/capture`);

  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({ error: "No face answered within two seconds." });
  expect(Date.now() - started).toBeLessThan(4_000);
}, 10_000);

test("a face that hears the ask and cannot take the picture is the same as no face", async () => {
  // A hidden or disabled widget declines rather than sending a stale frame. The
  // hub's answer is the truth either way: nobody answered.
  const face = widget({ capturePage: () => undefined });
  await face.opened;

  const response = await fetch(`http://127.0.0.1:${port}/api/orb/capture`);

  expect(response.status).toBe(504);
  expect(face.photographed).toHaveLength(1);

  face.ws.close();
}, 10_000);

test("a stranger cannot post a picture into somebody else's request", async () => {
  // The ids are what stand between a caller on this machine and a picture of a
  // desk corner, so an id nobody is waiting on gets one shape of refusal — the
  // same one an expired id and an already-answered id get.
  const face = widget({ capturePage: () => PNG });
  await face.opened;

  const posted = await fetch(`http://127.0.0.1:${port}/api/orb/capture/not-a-real-id`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: PNG.slice(),
  });

  expect(posted.status).toBe(404);
  expect(await posted.json()).toEqual({ error: "No capture was waiting under that id." });

  // And the real round trip still works afterwards: a refused stranger is not a
  // hub that stopped answering.
  const response = await fetch(`http://127.0.0.1:${port}/api/orb/capture`);
  expect(response.status).toBe(200);

  face.ws.close();
});
