import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import { DEVICE_SUBPROTOCOL_PREFIX } from "./device-credentials.ts";
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
 * The door admits two kinds of caller. A loopback peer — the kernel vouching
 * for a process on this machine — walks in, which is what keeps development
 * honest and every existing face working. Anyone else must present a device
 * credential this hub minted, as the WebSocket subprotocol
 * `comcon-device.<id>.<secret>` (see device-credentials.ts for why a
 * subprotocol and why that is only defensible under TLS or loopback). The hub
 * binds 127.0.0.1 today, so the credential path is exercised in-process rather
 * than end-to-end — it exists so the socket's security story stops being
 * "loopback", and so QR pairing (#35) has a door already checking what it will
 * mint. Refusal is one shape with no hint which part failed.
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

/**
 * How often the hub asks each face whether anyone is still there.
 *
 * The buffered-amount ceiling above only catches a dead face while the hub
 * has something to send it. A conversation that goes quiet sends nothing, so
 * a connection whose far end died without a goodbye — a suspended laptop, a
 * dropped Wi-Fi link, a process stopped rather than killed — sits OPEN with
 * nothing to trip on. That matters beyond memory: while it sits there it is
 * still counted as owning a voice session, so every widget's ears stay
 * plugged waiting for a `voice_closed` that only the kernel's retransmit
 * timeout will eventually produce, minutes or hours later. That is the shape
 * of "it went deaf and came back on its own".
 *
 * A ping is the transport's own word for the question, and its answer costs
 * a face nothing: `ws` replies to a ping from inside the library, so a page
 * whose JavaScript is busy still answers. What stops answering is a
 * connection whose far end is genuinely gone.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** What the door needs from the credential store: one question, answered slowly enough to be safe. */
export type CredentialCheck = {
  verify(presented: string): Promise<boolean>;
};

/**
 * What the hub is told about the conversation happening on this lane.
 *
 * Since the migration, the lane is the only place the hub learns anything
 * about voice at all — there is no hub-side session to watch. The face
 * events and the status route both derive from these notifications, so the
 * seam carries facts, never content: how many mouths are open, that an ask
 * is in flight, that an answer went out, and the caption text a session
 * already chose to publish. Nothing here says *who*, and nothing here can
 * carry audio.
 */
/**
 * One open voice session, in the only terms the hub has.
 *
 * Two timestamps and nothing else — not who, not what was said. `openedAt`
 * is when the connection claimed the session; `lastSpokeAt` is the last time
 * a frame the face's own code sent crossed the lane. A pong never advances
 * it: pongs are answered by the library on the far side, so a session kept
 * "recent" by them would be reporting the wire's health as the conversation's.
 */
export type VoiceSession = { openedAt: number; lastSpokeAt: number };

export type LaneObserver = {
  /** The number of connections holding an open voice session, on every change. */
  voiceCount?(count: number): void;
  /**
   * The open sessions, whenever one opens, closes, or says something.
   *
   * A count answers "is anything live"; this answers "how long has that thing
   * been live and when did it last do anything" — which is the difference
   * between seeing a stuck session and only seeing a busy hub.
   */
  voiceSessions?(sessions: readonly VoiceSession[]): void;
  /** An `ask` was handed to the brain. */
  askStarted?(): void;
  /** The brain's answer went back to the asker. */
  answerDelivered?(): void;
  /** A caption crossed the lane. The socket relays it to faces itself. */
  caption?(text: string): void;
};

export function attachEventSocket(
  server: UpgradableServer,
  source: EventSource,
  options: {
    path?: string;
    brain?: LaneBrain;
    credentials?: CredentialCheck;
    observer?: LaneObserver;
    /** How often faces are pinged. Tests drive this fast; nothing else sets it. */
    heartbeatMs?: number;
  } = {},
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
  const voiceOwners = new Map<WebSocket, VoiceSession>();

  const broadcast = (event: StateEvent) => {
    for (const deliver of [...deliverTo.values()]) deliver(event);
  };

  const publishSessions = () => {
    options.observer?.voiceSessions?.([...voiceOwners.values()].map((session) => ({ ...session })));
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
    options.observer?.voiceCount?.(voiceOwners.size);
    publishSessions();
    if (voiceOwners.size === 0) broadcast({ type: "voice_closed" });
  };

  const joinVoice = (ws: WebSocket) => {
    const wasEmpty = voiceOwners.size === 0;
    if (voiceOwners.has(ws)) return;
    const now = Date.now();
    voiceOwners.set(ws, { openedAt: now, lastSpokeAt: now });
    options.observer?.voiceCount?.(voiceOwners.size);
    publishSessions();
    if (wasEmpty) broadcast({ type: "voice_opened" });
  };

  /**
   * A session's owner said something.
   *
   * Only frames a face chose to send count. That is what makes a quiet time
   * mean anything: a session whose page froze goes quiet here while its
   * connection stays perfectly healthy, and that gap is the thing a person
   * reading the status route is trying to see.
   */
  const touchVoice = (ws: WebSocket) => {
    const session = voiceOwners.get(ws);
    if (!session) return;
    session.lastSpokeAt = Date.now();
    publishSessions();
  };

  /**
   * Each face's teardown, so an ending can be started from outside its own
   * handlers. The heartbeat is the one caller: it decides a connection is
   * gone while nothing on that connection is happening, and the set
   * transition a dead owner never got to send has to happen anyway.
   */
  const endFace = new Map<WebSocket, () => void>();

  /**
   * The faces that have been asked and have not yet answered.
   *
   * Membership is the whole test. A face is pinged and added; its pong
   * removes it. Finding it still here at the next sweep means a full interval
   * passed with no answer, so the far end is gone — evicted through the same
   * cleanup every other ending uses, which is what turns a silent death into
   * the `voice_closed` a widget is waiting on. Worst case is two intervals,
   * because a face pinged a moment before dying gets its full interval.
   */
  const awaitingPong = new Set<WebSocket>();

  const sweep = () => {
    for (const ws of [...wss.clients]) {
      if (ws.readyState !== ws.OPEN) continue;
      if (awaitingPong.has(ws)) {
        endFace.get(ws)?.();
        ws.terminate();
        continue;
      }
      awaitingPong.add(ws);
      ws.ping();
    }
  };

  // Unref'd: a hub with no faces attached should not be held open by the act
  // of being ready to notice one leaving.
  const heartbeat = setInterval(sweep, options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

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
    options.observer?.askStarted?.();
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
      options.observer?.answerDelivered?.();
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

    const admit = () => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    };

    // Refusal is one shape whichever check failed. A caller that could tell
    // "not loopback" from "unknown device" from "wrong secret" could walk the
    // door's logic one refusal at a time.
    const refuse = () => {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    };

    if (isLocalPeer(request.socket.remoteAddress)) {
      admit();
      return;
    }

    // A remote peer's only way in is a credential this hub minted, offered as
    // a subprotocol. The header may carry a comma-separated list; only entries
    // wearing the device prefix are considered, and the first one decides —
    // presenting several credentials is not a way to get several verdicts.
    const offered = (request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((protocol) => protocol.trim())
      .find((protocol) => protocol.startsWith(DEVICE_SUBPROTOCOL_PREFIX));
    const check = options.credentials;
    if (!offered || !check) {
      refuse();
      return;
    }
    void check
      .verify(offered)
      .then((valid) => {
        if (valid) admit();
        else refuse();
      })
      .catch(refuse);
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

    // The current voice state, to this face alone.
    //
    // `voice_opened` and `voice_closed` are edges: one when the set fills and
    // one when it empties. A face that was not connected for the edge it
    // needed can never learn the truth from a stream of edges — and a widget
    // is exactly that face, because it reconnects on its own after any hub
    // restart or dropped link. Missing the `voice_closed` while away leaves
    // its ears plugged with nothing coming that would ever unplug them.
    //
    // Told to the joiner only, never broadcast: this is an answer to "what is
    // happening", and the faces already here would read a second copy as
    // something having changed. The SSE stream opens with its current state
    // for the same reason (see the orb routes), so this is the socket
    // catching up with a habit the hub already has.
    deliver({ type: voiceOwners.size > 0 ? "voice_opened" : "voice_closed" });

    // Cleanup is one function because the endings are many: goodbye, crash, a
    // stuck buffer. Whichever fires, the hub ends holding no handler for a
    // window that is gone — and if the dead connection owned a voice session,
    // the set transition it never got to send happens anyway.
    const cleanup = () => {
      unsubscribe();
      deliverTo.delete(ws);
      endFace.delete(ws);
      awaitingPong.delete(ws);
      leaveVoice(ws);
    };
    endFace.set(ws, cleanup);

    // Answered by `ws` itself on the far side, which is the point: this says
    // the connection is alive, not that anyone over there is paying
    // attention. Liveness is all the heartbeat is entitled to claim.
    ws.on("pong", () => awaitingPong.delete(ws));

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

      // Anything the face said counts as it being awake, including the frame
      // that is about to open a session or close one.
      touchVoice(ws);

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
          // own caption back is confirmation, not an echo problem. The
          // observer is told separately because the SSE face is not on this
          // socket, and a face is a face wherever it connects.
          broadcast({ type: "caption", text: gesture.text });
          options.observer?.caption?.(gesture.text);
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
      clearInterval(heartbeat);
      server.off("upgrade", onUpgrade);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
