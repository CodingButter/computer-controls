/**
 * The widget's one connection to the world.
 *
 * One socket, to localhost, carrying state in and gestures out. That is the
 * entire surface this process has: no HTTP client, no credential, no path to
 * the daemon, and nothing that could be pointed at another machine. The address
 * is built here rather than passed in from a page so there is no configuration
 * seam through which it could become someone else's hub.
 *
 * Reconnection is included because the alternative is worse than it looks. A
 * hub restart, with no reconnect, leaves a widget that is still running, still
 * on top, and permanently deaf — and because it draws nothing when idle, it
 * looks exactly like a widget that is working. So it retries, with a backoff,
 * forever.
 */

/** Where the hub listens. Loopback, and not configurable to anywhere else. */
const HUB_HOST = "127.0.0.1";
const EVENTS_PATH = "/events";

const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 5000;

/**
 * @param {number} port
 * @returns {string}
 */
export function hubEventsUrl(port) {
  return `ws://${HUB_HOST}:${port}${EVENTS_PATH}`;
}

/**
 * The next delay, backing off but never giving up.
 *
 * Capped because a widget that has backed off to ten minutes is one the user
 * will restart by hand, which is a worse outcome than a socket that politely
 * knocks every five seconds.
 *
 * @param {number} previous
 * @returns {number}
 */
export function nextRetryDelay(previous) {
  if (previous <= 0) return FIRST_RETRY_MS;
  return Math.min(previous * 2, MAX_RETRY_MS);
}

/**
 * Open the connection and keep it open.
 *
 * @param {{
 *   port: number,
 *   onEvent: (event: { type: string, text?: string }) => void,
 *   onConnectionChange?: (connected: boolean) => void,
 *   WebSocketImpl?: typeof WebSocket,
 *   setTimeoutImpl?: typeof setTimeout,
 * }} options
 */
export function connectToHub(options) {
  const {
    port,
    onEvent,
    onConnectionChange = () => {},
    WebSocketImpl = WebSocket,
    setTimeoutImpl = setTimeout,
  } = options;

  let socket = /** @type {WebSocket | null} */ (null);
  let delay = 0;
  let closed = false;

  const open = () => {
    if (closed) return;
    const ws = new WebSocketImpl(hubEventsUrl(port));
    socket = ws;

    ws.addEventListener("open", () => {
      delay = 0;
      onConnectionChange(true);
    });

    ws.addEventListener("message", (message) => {
      // Whatever arrives is parsed and handed on. The state machine is total
      // over the vocabulary and ignores anything outside it, so a malformed
      // frame becomes a no-op rather than a thrown error inside a handler.
      let parsed;
      try {
        parsed = JSON.parse(String(/** @type {MessageEvent} */ (message).data));
      } catch {
        return;
      }
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        onEvent(parsed);
      }
    });

    ws.addEventListener("close", () => {
      onConnectionChange(false);
      delay = nextRetryDelay(delay);
      setTimeoutImpl(open, delay);
    });

    // An error is followed by a close, which is where the retry lives. Handled
    // only to keep it from surfacing as an unhandled event.
    ws.addEventListener("error", () => {});
  };

  open();

  return {
    /**
     * Ask the hub for something. The only things it is possible to ask for are
     * the three gestures, because those are the only things the hub offers.
     * @param {{ type: string, x?: number, y?: number }} gesture
     */
    send(gesture) {
      if (socket && socket.readyState === 1) socket.send(JSON.stringify(gesture));
    },
    close() {
      closed = true;
      if (socket) socket.close();
    },
  };
}
