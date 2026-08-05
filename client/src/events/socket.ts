import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import type { EventSource } from "./source.ts";
import { parseGesture, type StateEvent } from "./types.ts";

/**
 * The one stream between the hub and its faces.
 *
 * The shape is fixed by what a face is allowed to be. State events go out;
 * gestures come in; nothing else crosses in either direction. A mouth may
 * `ask` — one request, routed whole to the same brain the typed lane runs, and
 * answered in words — but it names no tool and holds no path to the daemon,
 * and there is no audio on the wire at all: a caption is text a session
 * already decided to publish, not a sample of a room. That is what makes the
 * privacy claim checkable rather than aspirational: the socket has no
 * vocabulary for the thing that would violate it.
 *
 * Localhost only, and that is load-bearing rather than a default. The hub's
 * port is already the whole boundary — no auth adapter, no tenant path — so a
 * face reachable from the network would be an unauthenticated window onto a
 * machine's spoken conversation. The upgrade is refused unless the connection
 * came from this machine.
 */

/** Where a face connects. Not under /api: this is an upgrade, not a route. */
export const EVENTS_PATH = "/events";

/**
 * The only thing this module needs from the server it attaches to.
 *
 * Named structurally rather than as `http.Server` because the hub's server
 * comes back from `@hono/node-server`, whose return type is a union that also
 * covers HTTP/2. Widening to the union would mean carrying HTTP/2 shapes this
 * module has no meaning for; narrowing with a cast would be asserting something
 * about the caller instead of asking for it. What is actually required is an
 * emitter that reports upgrades.
 */
export type UpgradableServer = {
  on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
};

/**
 * The brain, as far as the lane is concerned.
 *
 * Structurally identical to the orb's `HubBrain`, and deliberately not
 * imported from there: the lane outlives the hub-side realtime session, and a
 * type import in this direction would tie the socket's compile to a module the
 * migration retires. One method, callable with nothing but a request — that is
 * the whole dispatch seam.
 */
export type LaneBrain = {
  ask(request: string, onProgress?: (signal: string) => void): Promise<string>;
};

/**
 * What the lane answers when the brain throws.
 *
 * The same sentence the orb's dispatch speaks today, for the same reason: a
 * mouth mid-conversation needs a complete sentence to say, and the error's
 * text belongs in the hub's log, not in a stranger's ears.
 */
export const ASK_FAILED = "That did not work. Nothing was changed.";

export type EventSocket = {
  /**
   * The faces attached right now.
   *
   * Read-only, and offered because the hub genuinely has reason to look: how
   * many faces are watching, and whether any of them has stopped reading, are
   * both questions about the hub's own health rather than internals of this
   * module.
   */
  readonly faces: readonly WebSocket[];
  /** How many faces are attached right now. */
  readonly faceCount: number;
  /** Stop serving and hang up on everyone still attached. */
  close(): Promise<void>;
};

/**
 * A loopback peer, by the kernel's account rather than by its own.
 *
 * The address is read off the socket, never off a header. `x-forwarded-for`
 * and `origin` are things the caller writes, so a check that consulted them
 * would be asking the stranger whether he is a stranger. A proxy could still
 * front this, but a proxy in front of a hub that binds loopback is a decision
 * someone made deliberately, and no check here would survive it anyway.
 *
 * Exported because it is a security control rather than a detail, and worth
 * asserting against directly instead of only through an arranged TCP peer.
 */
export function isLocalPeer(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "::1") return true;
  // Anchored rather than a prefix test. In practice the kernel hands back a
  // numeric address and a prefix would do, but "starts with 127." also admits
  // `127.0.0.1.evil.com`, and a security check that relies on its input never
  // being a hostname is one refactor away from not being a check.
  return LOOPBACK_V4.test(address.startsWith("::ffff:") ? address.slice(7) : address);
}

/** The whole 127.0.0.0/8 block, which is all loopback and nothing else. */
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * How far a face may fall behind before the hub stops writing to it.
 *
 * Generous by the standards of what crosses here — state events are tens of
 * bytes and a caption line is not much more — so a face reading at any human
 * rate never approaches it. It is a ceiling on a stuck reader, not a flow
 * control policy for a healthy one.
 */
const MAX_BUFFERED_BYTES = 1 << 20;

export function attachEventSocket(
  server: UpgradableServer,
  source: EventSource,
  options: { path?: string; brain?: LaneBrain } = {},
): EventSocket {
  const path = options.path ?? EVENTS_PATH;
  // `noServer` because the hub's HTTP app owns this server. Letting `ws` bind
  // its own listener would put a second thing in front of the port that Hono
  // does not know about.
  const wss = new WebSocketServer({ noServer: true });

  // Each face's delivery function, so a broadcast rides the same buffered-
  // amount discipline the subscription path enforces. A stuck reader is hung
  // up on identically whether the word came from the hub's source or from
  // another face's mouth.
  const deliverTo = new Map<WebSocket, (event: StateEvent) => void>();

  /**
   * The connections that currently own an open voice session.
   *
   * A set, not a count: the same connection saying `voice_open` twice is one
   * membership, and only transitions of the whole set broadcast. Two openers
   * produce one `voice_opened`; a joiner produces nothing — which is how a
   * client tells "my open caused this" from "someone else was already talking".
   */
  const voiceOwners = new Set<WebSocket>();

  const broadcast = (event: StateEvent) => {
    for (const deliver of [...deliverTo.values()]) deliver(event);
  };

  /**
   * A member leaves the voice set — by saying `voice_close`, or by dying.
   *
   * Both paths land here on purpose. A widget deafened by a crashed page is a
   * bug a user cannot see: the set would stay half-open forever and no
   * `voice_closed` would ever unplug its ears. Socket death counts as closing.
   */
  const leaveVoice = (ws: WebSocket) => {
    if (!voiceOwners.delete(ws)) return;
    if (voiceOwners.size === 0) broadcast({ type: "voice_closed" });
  };

  const joinVoice = (ws: WebSocket) => {
    const wasEmpty = voiceOwners.size === 0;
    voiceOwners.add(ws);
    if (wasEmpty) broadcast({ type: "voice_opened" });
  };

  /**
   * Ack-then-background, the shape the orb's dispatch already has: the reply
   * to the frame is immediate silence (WebSocket frames are not requests),
   * the work happens behind it, and `progress`/`answer` land on the asking
   * connection only — the id is that asker's correlation id, meaningless to
   * anyone else. A lane with no brain treats `ask` as noise: answering "no
   * brain" would be telling an unauthenticated stranger about the hub's
   * internals, and the word is simply not in service yet.
   */
  const dispatchAsk = (ws: WebSocket, ask: { id: string; request: string }) => {
    const brain = options.brain;
    if (!brain) return;
    const reply = (event: StateEvent) => deliverTo.get(ws)?.(event);
    void (async () => {
      let answer: string;
      try {
        answer = await brain.ask(ask.request, (signal) => {
          reply({ type: "progress", id: ask.id, text: signal });
        });
      } catch {
        answer = ASK_FAILED;
      }
      reply({ type: "answer", id: ask.id, text: answer });
    })();
  };

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // A URL is only parsed far enough to route it. Anything after the path —
    // query, fragment — is not part of the contract and is not read.
    const requested = (request.url ?? "").split("?")[0];

    // An upgrade to anywhere else is closed rather than ignored.
    //
    // Ignoring it would leak the connection: Node destroys an unhandled
    // upgrade only while nothing is listening for the event, and attaching
    // this listener turns that off for the whole server. A silent `return`
    // therefore leaves a socket open forever, held by a client still waiting
    // for a handshake that no one is going to send.
    //
    // Closing it is also honest about the design. The hub offers one event
    // stream; there is no second upgrade path for this to be stepping on.
    if (requested !== path) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!isLocalPeer(request.socket.remoteAddress)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  };

  server.on("upgrade", onUpgrade);

  wss.on("connection", (ws: WebSocket) => {
    const deliver = (event: StateEvent) => {
      if (ws.readyState !== ws.OPEN) return;

      // A face that stopped reading does not get to grow the hub's memory.
      //
      // This socket is long-lived and the hub talks all day, so a widget whose
      // window froze, or whose laptop suspended mid-sentence, would sit there
      // with a live TCP connection accepting nothing. `send` would keep
      // buffering captions into it, and a publisher that trims nothing is
      // exactly how a stream eats a machine.
      //
      // It is hung up on rather than quietly skipped, and the difference
      // matters: `idle` is the last event of a turn, so a face that missed it
      // would sit on the user's desk forever waiting for a next event that is
      // never coming. Closing the socket cannot strand it that way. The widget
      // reconnects on its own and comes back hidden, which is the one state
      // that is safe to be wrong about.
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        cleanup();
        ws.terminate();
        return;
      }

      ws.send(JSON.stringify(event));
    };

    const unsubscribe = source.subscribe(deliver);
    deliverTo.set(ws, deliver);

    // Cleanup is one function because the endings are many: goodbye, crash, a
    // stuck buffer. Whichever fires, the hub ends holding no handler for a
    // window that is gone — and if the dead connection owned a voice session,
    // the set transition it never got to send happens anyway.
    const cleanup = () => {
      unsubscribe();
      deliverTo.delete(ws);
      leaveVoice(ws);
    };

    ws.on("message", (raw: unknown, isBinary: boolean) => {
      // Binary is refused before it is even looked at. Nothing in the
      // vocabulary is binary, so a binary frame is by definition something the
      // hub never agreed to carry — an audio buffer being the obvious one.
      if (isBinary) return;

      const gesture = parseGesture(String(raw));
      // Noise gets no answer. A face that learned which of its guesses parsed
      // could walk the vocabulary one refusal at a time; silence tells it
      // nothing it did not already know.
      if (!gesture) return;

      // The conversation words are the lane's own. Everything else — mute,
      // dismiss, drag — is intent about the hub's state and goes to the
      // source, which is the seam the orb's gate listens on. The split is the
      // point: a source never learns which connection said what, and the lane
      // never interprets a gesture it merely carries.
      switch (gesture.type) {
        case "voice_open":
          joinVoice(ws);
          return;
        case "voice_close":
          leaveVoice(ws);
          return;
        case "caption":
          // Relayed to every face, the sender included — a mouth hearing its
          // own caption back is confirmation, not an echo problem.
          broadcast({ type: "caption", text: gesture.text });
          return;
        case "ask":
          dispatchAsk(ws, gesture);
          return;
        default:
          source.handleGesture?.(gesture);
      }
    });

    ws.on("close", cleanup);
    ws.on("error", () => {
      cleanup();
      ws.terminate();
    });
  });

  return {
    get faces() {
      return [...wss.clients];
    },
    get faceCount() {
      return wss.clients.size;
    },
    async close() {
      server.off("upgrade", onUpgrade);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
