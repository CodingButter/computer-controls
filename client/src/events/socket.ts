import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import type { EventSource } from "./source.ts";
import { parseGesture, type StateEvent } from "./types.ts";

/**
 * The one stream between the hub and its faces.
 *
 * The shape is fixed by what a face is allowed to be. State events go out;
 * gestures come in; nothing else crosses in either direction. There is no
 * request the face can make, no tool it can name, and no audio on the wire at
 * all — a caption is text the hub already decided to publish, not a sample of a
 * room. That is what makes the privacy claim checkable rather than aspirational:
 * the socket has no vocabulary for the thing that would violate it.
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
  options: { path?: string } = {},
): EventSocket {
  const path = options.path ?? EVENTS_PATH;
  // `noServer` because the hub's HTTP app owns this server. Letting `ws` bind
  // its own listener would put a second thing in front of the port that Hono
  // does not know about.
  const wss = new WebSocketServer({ noServer: true });

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
    const unsubscribe = source.subscribe((event: StateEvent) => {
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
        unsubscribe();
        ws.terminate();
        return;
      }

      ws.send(JSON.stringify(event));
    });

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

      source.handleGesture?.(gesture);
    });

    // Both endings run the same cleanup: a face that crashes and a face that
    // says goodbye leave the hub in the same state, holding no handler for a
    // window that is gone.
    ws.on("close", unsubscribe);
    ws.on("error", () => {
      unsubscribe();
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
