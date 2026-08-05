import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";

import { ASK_FAILED, EVENTS_PATH, attachEventSocket, isLocalPeer, type EventSocket } from "./socket.ts";
import { ScriptedEventSource } from "./source.ts";
import type { StateEvent } from "./types.ts";

/**
 * The socket, served off a real HTTP server and spoken to by a real client.
 *
 * Nothing here stubs the transport. The claims being made are about what
 * crosses a wire, so a test that asserted against a mocked wire would be
 * asserting against its own mock.
 */

let server: Server;
let socket: EventSocket;
let source: ScriptedEventSource;
let url: string;
const open: WebSocket[] = [];

/** The brain, played by a hand: every ask recorded, every answer scripted. */
let asked: { request: string; onProgress?: (signal: string) => void }[];
let answerWith: (request: string) => Promise<string>;

beforeEach(async () => {
  source = new ScriptedEventSource();
  asked = [];
  answerWith = async () => "Done.";
  // A bare HTTP server standing in for the hub's: this module attaches to an
  // upgrade listener, and Hono is not part of that contract.
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("hub");
  });
  socket = attachEventSocket(server, source, {
    brain: {
      ask: (request, onProgress) => {
        asked.push({ request, ...(onProgress ? { onProgress } : {}) });
        return answerWith(request);
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  url = `ws://127.0.0.1:${address.port}${EVENTS_PATH}`;
});

afterEach(async () => {
  for (const client of open) client.close();
  open.length = 0;
  await socket.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A face, connected and ready to be spoken to. */
async function connectFace(target: string = url): Promise<WebSocket> {
  const client = new WebSocket(target);
  open.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  return client;
}

/** Everything a face hears, collected as it arrives. */
function collect(client: WebSocket): StateEvent[] {
  const heard: StateEvent[] = [];
  client.on("message", (raw) => heard.push(JSON.parse(String(raw)) as StateEvent));
  return heard;
}

/** Let the event loop carry whatever is in flight to the other end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("test_the_event_socket_carries_state_out_and_gestures_in_and_nothing_else", async () => {
  const face = await connectFace();
  const heard = collect(face);

  // Out: every state word the hub has, in the order a turn produces them.
  source.emitAll([
    { type: "wake_opened" },
    { type: "caption", text: "what is on my calendar" },
    { type: "thinking" },
    { type: "speaking" },
    { type: "idle" },
  ]);
  await settle();
  expect(heard).toEqual([
    { type: "wake_opened" },
    { type: "caption", text: "what is on my calendar" },
    { type: "thinking" },
    { type: "speaking" },
    { type: "idle" },
  ]);

  // In: every gesture a person has.
  face.send(JSON.stringify({ type: "mute" }));
  face.send(JSON.stringify({ type: "drag", x: 400, y: 120 }));
  face.send(JSON.stringify({ type: "dismiss" }));
  await settle();
  expect(source.received).toEqual([
    { type: "mute" },
    { type: "drag", x: 400, y: 120 },
    { type: "dismiss" },
  ]);

  // And nothing else. Each of these is a plausible thing a compromised or
  // over-ambitious face would try, and none of them reach the hub.
  const before = source.received.length;
  face.send(JSON.stringify({ type: "run_tool", name: "execute_command" }));
  face.send(JSON.stringify({ type: "read_file", path: "/etc/passwd" }));
  face.send(JSON.stringify({ type: "mute", alsoRunShell: "rm -rf /" }));
  face.send(JSON.stringify({ type: "wake_opened" })); // a face may not announce state
  face.send("not json at all");
  await settle();
  expect(source.received).toHaveLength(before);

  // Refusal is silent: no error frame came back that would tell a caller which
  // of its guesses parsed, and the connection is still up.
  expect(heard).toHaveLength(5);
  expect(face.readyState).toBe(WebSocket.OPEN);
});

test("test_idle_audio_never_leaves_the_machine_with_the_widget_running", async () => {
  const face = await connectFace();
  const heard: unknown[] = [];
  const binaryHeard: unknown[] = [];
  face.on("message", (raw, isBinary) => {
    (isBinary ? binaryHeard : heard).push(raw);
  });

  // The hub sits idle with a face attached — the exact condition the privacy
  // claim is about. A wake never opens, so nothing is said.
  await settle();
  expect(heard).toHaveLength(0);
  expect(binaryHeard).toHaveLength(0);

  // Now a whole turn happens. Even mid-conversation, what crosses is text the
  // hub decided to publish. Not one frame is binary, because the socket has no
  // word whose payload is a sample.
  source.emitAll([
    { type: "wake_opened" },
    { type: "caption", text: "turn the lights down" },
    { type: "speaking" },
    { type: "idle" },
  ]);
  await settle();
  expect(binaryHeard).toHaveLength(0);
  for (const frame of heard) {
    const parsed = JSON.parse(String(frame)) as Record<string, unknown>;
    // A caption carries the transcript the hub already produced. Nothing else
    // carries a payload at all.
    expect(Object.keys(parsed).every((key) => key === "type" || key === "text")).toBe(true);
  }

  // The other direction is the one that would actually leak a room: a face
  // with a microphone pushing samples up. Binary frames are dropped before
  // they are read, and no text frame naming audio is in the vocabulary.
  face.send(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x02]));
  face.send(JSON.stringify({ type: "audio", pcm: [0, 1, 2, 3] }));
  face.send(JSON.stringify({ type: "mute", audio: "UklGRg==" }));
  await settle();
  expect(source.received).toHaveLength(0);
});

describe("the socket", () => {
  test("serves several faces the same events at once", async () => {
    // The orb page and the widget are two faces over one set of ears. Neither
    // is the owner and neither displaces the other.
    const orb = await connectFace();
    const widget = await connectFace();
    const orbHeard = collect(orb);
    const widgetHeard = collect(widget);

    source.emit({ type: "wake_opened" });
    source.emit({ type: "caption", text: "both of you" });
    await settle();

    expect(orbHeard).toEqual(widgetHeard);
    expect(orbHeard).toHaveLength(2);
    expect(socket.faceCount).toBe(2);
  });

  test("hangs up on a face that has stopped reading rather than buffering for it", async () => {
    // A frozen window or a suspended laptop leaves a live TCP connection that
    // accepts nothing, and a publisher that keeps buffering into it is how a
    // long-lived stream eats a machine.
    const face = await connectFace();
    await settle();
    expect(source.watcherCount).toBe(1);

    // Stand in for a reader that stopped: the send buffer is what the hub can
    // actually observe about a face, so that is what is driven past the limit.
    const [served] = socket.faces;
    Object.defineProperty(served!, "bufferedAmount", { get: () => 8 * 1024 * 1024 });

    source.emit({ type: "caption", text: "into a window that froze" });
    await settle();

    // Hung up on, and fully forgotten — no handler left writing into it.
    expect(source.watcherCount).toBe(0);
    expect(socket.faceCount).toBe(0);

    // The hub is unharmed and still serving whoever else is watching. This is
    // the property that matters: one bad face is not an outage.
    const replacement = await connectFace();
    const heard = collect(replacement);
    source.emit({ type: "idle" });
    await settle();
    expect(heard).toEqual([{ type: "idle" }]);
  });

  test("forgets a face that closes, so a shut widget leaves nothing behind", async () => {
    const face = await connectFace();
    await settle();
    expect(source.watcherCount).toBe(1);

    face.close();
    await settle();
    // The ears outlive the face. What must not outlive it is a handler writing
    // into a socket that is gone.
    expect(source.watcherCount).toBe(0);
    expect(socket.faceCount).toBe(0);
  });

  test("closes an upgrade to any other path instead of leaving it hanging", async () => {
    // Attaching an upgrade listener turns off Node's own cleanup for the whole
    // server, so a path this module declines has to be closed here or the
    // connection is held open forever by a client awaiting a handshake.
    const stray = new WebSocket(url.replace(EVENTS_PATH, "/api/something-else"));
    open.push(stray);
    const failed = await new Promise<boolean>((resolve) => {
      stray.once("error", () => resolve(true));
      stray.once("open", () => resolve(false));
    });
    expect(failed).toBe(true);
    expect(socket.faceCount).toBe(0);
  });

  test("still serves ordinary http on the same port", async () => {
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    expect(await response.text()).toBe("hub");
  });

  test("counts only loopback as this machine", () => {
    // The hub's port is the whole boundary — no auth adapter, no tenant path —
    // so a face reachable from the network would be an unauthenticated window
    // onto a room's spoken conversation.
    expect(isLocalPeer("127.0.0.1")).toBe(true);
    expect(isLocalPeer("::1")).toBe(true);
    expect(isLocalPeer("::ffff:127.0.0.1")).toBe(true);
    expect(isLocalPeer("127.0.0.53")).toBe(true);

    expect(isLocalPeer("8.8.8.8")).toBe(false);
    expect(isLocalPeer("192.168.1.40")).toBe(false);
    expect(isLocalPeer("10.0.0.5")).toBe(false);
    expect(isLocalPeer("100.107.144.64")).toBe(false); // a tailnet peer is not this machine
    expect(isLocalPeer(undefined)).toBe(false);
    // Close enough to fool a careless prefix check, and not loopback.
    expect(isLocalPeer("127.0.0.1.evil.com")).toBe(false);
    expect(isLocalPeer("1270.0.0.1")).toBe(false);
  });

  test("reads the peer off the socket, so a forged header buys nothing", async () => {
    // A caller writes its own headers, so a check that consulted them would be
    // asking the stranger whether he is a stranger. These change nothing: the
    // connection is admitted on the kernel's account of where it came from.
    const client = new WebSocket(url, {
      headers: { "x-forwarded-for": "8.8.8.8", origin: "http://evil.example" },
    });
    open.push(client);
    const opened = await new Promise<boolean>((resolve) => {
      client.once("open", () => resolve(true));
      client.once("error", () => resolve(false));
    });
    expect(opened).toBe(true);
  });
});

describe("the voice set", () => {
  test("broadcasts on set transitions, never on memberships", async () => {
    const widget = await connectFace();
    const page = await connectFace();
    const widgetHeard = collect(widget);
    const pageHeard = collect(page);

    // The first opener transitions the set: one broadcast, to everyone. The
    // page that caused it hears it too — hearing voice_opened right after
    // your own open is how a client knows its open was first.
    page.send(JSON.stringify({ type: "voice_open" }));
    await settle();
    expect(widgetHeard).toEqual([{ type: "voice_opened" }]);
    expect(pageHeard).toEqual([{ type: "voice_opened" }]);

    // A joiner is not a transition. This silence is load-bearing: a widget
    // that heard a second voice_opened could not tell "someone else was
    // already talking" from "my open caused this".
    widget.send(JSON.stringify({ type: "voice_open" }));
    await settle();
    expect(widgetHeard).toHaveLength(1);
    expect(pageHeard).toHaveLength(1);

    // The first closer leaves a non-empty set: still no broadcast.
    page.send(JSON.stringify({ type: "voice_close" }));
    await settle();
    expect(widgetHeard).toHaveLength(1);

    // The last closer empties it: one voice_closed, to everyone.
    widget.send(JSON.stringify({ type: "voice_close" }));
    await settle();
    expect(widgetHeard).toEqual([{ type: "voice_opened" }, { type: "voice_closed" }]);
    expect(pageHeard).toEqual([{ type: "voice_opened" }, { type: "voice_closed" }]);

    // None of it reached the source: arbitration is the lane's own business,
    // and the ear chain never learns which connection said what.
    expect(source.received).toHaveLength(0);
  });

  test("a voice_close from a connection that never opened changes nothing", async () => {
    const bystander = await connectFace();
    const widget = await connectFace();
    const widgetHeard = collect(widget);

    bystander.send(JSON.stringify({ type: "voice_close" }));
    await settle();
    expect(widgetHeard).toHaveLength(0);
  });

  test("a socket that dies without saying voice_close counts as having said it", async () => {
    // The failure a user cannot see: a page crashes mid-conversation, the set
    // never empties, and the widget sits with plugged ears forever. Socket
    // death is closing, whether or not the client got to say so.
    const widget = await connectFace();
    const page = await connectFace();
    const widgetHeard = collect(widget);

    page.send(JSON.stringify({ type: "voice_open" }));
    await settle();
    expect(widgetHeard).toEqual([{ type: "voice_opened" }]);

    page.terminate();
    await settle();
    expect(widgetHeard).toEqual([{ type: "voice_opened" }, { type: "voice_closed" }]);
  });

  test("a crash of one owner among two closes nothing", async () => {
    const widget = await connectFace();
    const first = await connectFace();
    const second = await connectFace();
    const widgetHeard = collect(widget);

    first.send(JSON.stringify({ type: "voice_open" }));
    second.send(JSON.stringify({ type: "voice_open" }));
    await settle();
    expect(widgetHeard).toEqual([{ type: "voice_opened" }]);

    // One of two owners dies: the set is still occupied, so nothing is said.
    first.terminate();
    await settle();
    expect(widgetHeard).toHaveLength(1);

    // The survivor closing is what empties it.
    second.send(JSON.stringify({ type: "voice_close" }));
    await settle();
    expect(widgetHeard).toEqual([{ type: "voice_opened" }, { type: "voice_closed" }]);
  });
});

describe("the conversation", () => {
  test("an ask routes to the brain and answers on the asking socket only", async () => {
    const mouth = await connectFace();
    const bystander = await connectFace();
    const mouthHeard = collect(mouth);
    const bystanderHeard = collect(bystander);

    let sendProgress!: (signal: string) => void;
    let finish!: (answer: string) => void;
    answerWith = () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      });

    mouth.send(JSON.stringify({ type: "ask", id: "call-1", request: "what is on my calendar" }));
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.request).toBe("what is on my calendar");
    sendProgress = asked[0]!.onProgress!;

    // Progress lands mid-flight, on the asker, carrying the asker's own id.
    sendProgress("You are now working on: calendar.");
    await settle();
    expect(mouthHeard).toEqual([
      { type: "progress", id: "call-1", text: "You are now working on: calendar." },
    ]);

    finish("Two meetings, both before noon.");
    await settle();
    expect(mouthHeard).toEqual([
      { type: "progress", id: "call-1", text: "You are now working on: calendar." },
      { type: "answer", id: "call-1", text: "Two meetings, both before noon." },
    ]);

    // The reply is addressed, not broadcast: another face never hears a
    // conversation it is not holding.
    expect(bystanderHeard).toHaveLength(0);
    // And the ask never reached the source — the brain is the lane's seam.
    expect(source.received).toHaveLength(0);
  });

  test("a brain that throws answers with the fixed sentence, never the error", async () => {
    const mouth = await connectFace();
    const mouthHeard = collect(mouth);
    answerWith = async () => {
      throw new Error("ECONNREFUSED at internal-host:5432");
    };

    mouth.send(JSON.stringify({ type: "ask", id: "call-2", request: "do the thing" }));
    await settle();
    expect(mouthHeard).toEqual([{ type: "answer", id: "call-2", text: ASK_FAILED }]);
    // The error's text stayed on the hub. A stranger's ears get a sentence,
    // not a stack trace naming internal hosts.
    expect(JSON.stringify(mouthHeard)).not.toContain("ECONNREFUSED");
  });

  test("an answer to a mouth that died is dropped, not delivered to a stranger", async () => {
    const mouth = await connectFace();
    const bystander = await connectFace();
    const bystanderHeard = collect(bystander);

    let finish!: (answer: string) => void;
    answerWith = () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      });

    mouth.send(JSON.stringify({ type: "ask", id: "call-3", request: "slow thing" }));
    await settle();
    mouth.terminate();
    await settle();
    finish("Too late.");
    await settle();
    expect(bystanderHeard).toHaveLength(0);
  });

  test("a caption from a mouth is relayed to every face", async () => {
    const mouth = await connectFace();
    const widget = await connectFace();
    const mouthHeard = collect(mouth);
    const widgetHeard = collect(widget);

    mouth.send(JSON.stringify({ type: "caption", text: "turn the lights down" }));
    await settle();
    // Every face, the sender included — a mouth hearing its own caption back
    // is confirmation, not an echo problem. It arrives as the state word,
    // indistinguishable from a caption the hub produced itself.
    expect(widgetHeard).toEqual([{ type: "caption", text: "turn the lights down" }]);
    expect(mouthHeard).toEqual([{ type: "caption", text: "turn the lights down" }]);
    expect(source.received).toHaveLength(0);
  });

  test("a lane with no brain treats an ask as noise", async () => {
    // A hub booted without a brain — or before one — answers nothing.
    // Answering "no brain here" would tell a caller about the hub's insides.
    const bare = createServer((_request, response) => response.end("hub"));
    const bareSource = new ScriptedEventSource();
    const bareSocket = attachEventSocket(bare, bareSource);
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
    const address = bare.address();
    if (typeof address === "string" || address === null) throw new Error("no port");

    try {
      const mouth = await connectFace(`ws://127.0.0.1:${address.port}${EVENTS_PATH}`);
      const heard = collect(mouth);
      mouth.send(JSON.stringify({ type: "ask", id: "call-1", request: "anyone home" }));
      await settle();
      expect(heard).toHaveLength(0);
      expect(mouth.readyState).toBe(WebSocket.OPEN);
    } finally {
      await bareSocket.close();
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });
});
