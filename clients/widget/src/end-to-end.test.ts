import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, test } from "vitest";
import WebSocket from "ws";

import { ScriptedEventSource } from "../../../client/src/events/source.ts";
import { attachEventSocket } from "../../../client/src/events/socket.ts";
import { INITIAL_STATE, applyGesture, reduce } from "./state-machine.js";
import { paintCaption, scoutRects } from "./paint.js";

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

let server: ReturnType<typeof createServer>;
let source: ScriptedEventSource;
let socket: ReturnType<typeof attachEventSocket>;
let port: number;

beforeEach(async () => {
  server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  source = new ScriptedEventSource();
  socket = attachEventSocket(server, source);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  socket.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A widget: the real modules, wired the way the renderer wires them. */
function widget() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events`);
  let state = INITIAL_STATE;
  const painted = { textContent: "" };
  const captions: string[] = [];

  ws.on("message", (raw: Buffer) => {
    state = reduce(state, JSON.parse(raw.toString()));
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
    gesture(g: { type: string; x?: number; y?: number }) {
      state = applyGesture(state, g);
      ws.send(JSON.stringify(g));
    },
  };
}

/** Let everything in flight arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

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

  // The turn ends: the face fades and takes the words with it.
  source.emit({ type: "idle" });
  await settle();
  expect(face.state.presence).toBe("hidden");
  expect(face.onScreen).toBe("");

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

test("a scout is drawn over the element the agent is actually touching", async () => {
  const face = widget();
  await face.opened;

  // The face is on the right-hand monitor of a two-screen desk, which is the
  // arrangement where a screen coordinate and a page coordinate are different
  // numbers and a mistake is visible.
  const stage = { x: 1920, y: 0, width: 2560, height: 1440 };

  source.emit({ type: "wake_opened" });
  await settle();
  // Nothing is being touched yet: one orb, no scouts. This is the acceptance
  // criterion's idle case, over the real socket.
  expect(scoutRects(face.state.scouts, stage)).toEqual([]);

  // The agent reaches for a button. The hub reports the rectangle the desktop
  // gave it, in screen coordinates, and the face puts a scout on it.
  source.emit({ type: "touching", id: "call-1", x: 2400, y: 512, width: 96, height: 28 });
  // And a second operation on the far monitor, which this face cannot see.
  source.emit({ type: "touching", id: "call-2", x: 200, y: 512, width: 96, height: 28 });
  await settle();

  expect(scoutRects(face.state.scouts, stage)).toEqual([
    { id: "call-1", left: 480, top: 512, width: 96, height: 28 },
  ]);

  // The work finishes and the scout goes with it. A rectangle left glowing
  // over a button nobody is pressing is the lie this feature is built against.
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
