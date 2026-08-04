/**
 * Connect: trade a shared secret for a bearer token, then open a WebSocket.
 *
 * The PWA never touches the daemon socket. It talks to the server layer over
 * HTTP (POST /session) and WebSocket (/ws), authenticating with a bearer token.
 */

export interface ConnectionResult {
  token: string;
  ws: WebSocket;
}

export class ConnectError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Connect to the server: trade the shared secret for a token, then open a
 * WebSocket to /ws authenticated with that token.
 *
 * @param serverUrl  Base URL of the server (e.g. https://computer.lan:8000)
 * @param secret     The shared secret configured on the server
 */
export async function connect(
  serverUrl: string,
  secret: string,
): Promise<ConnectionResult> {
  const url = new URL(serverUrl);
  const base = `${url.protocol}//${url.host}`;

  // Trade secret → token
  const resp = await fetch(`${base}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new ConnectError(
      body.error ?? `HTTP ${resp.status}`,
      resp.status,
    );
  }

  const { token } = (await resp.json()) as { token: string };

  // Open WebSocket with token as query param
  const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${url.host}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new ConnectError("WebSocket connection timed out"));
    }, 10_000);

    ws.onopen = () => {
      clearTimeout(timeout);
      resolve({ token, ws });
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new ConnectError("WebSocket connection failed"));
    };
  });
}
