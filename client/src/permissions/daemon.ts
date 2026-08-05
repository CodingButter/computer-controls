import fs from "node:fs";
import { connect } from "node:net";
import path from "node:path";

/**
 * The one daemon question the permissions page asks: what is running.
 *
 * A deliberately tiny client — one request, one connection, closed after the
 * answer. The hub already reaches the daemon through the desktop plugin for
 * the agent's sake; this lane exists because a page render must not spend an
 * agent turn to draw a checklist. It speaks the same newline-framed JSON-RPC
 * the plugin does, and it only ever asks `listApplications`, an observe-class
 * method a fresh connection already holds. Nothing here can widen anything:
 * the socket has no method that widens, and this client asks one question.
 */

export type CensusApplication = { name: string; running: true; readable: boolean };

export type Census =
  | { reachable: true; applications: CensusApplication[] }
  | { reachable: false; reason: string };

/**
 * Where a shared daemon listens. The digest lives in the socket's filename, so
 * rather than baking a copy of it here we look for whatever daemon is actually
 * listening — the socket that exists is the daemon we can talk to.
 */
export function findDaemonSocket(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.MASTRACODE_DESKTOP_SOCKET) return env.MASTRACODE_DESKTOP_SOCKET;
  const runtimeDir = env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  const dir = path.join(runtimeDir, "mastracode-desktop");
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  // A shared daemon listens on daemon-<digest>.sock; a supervised session
  // daemon listens on mc-<pid>.sock. Either answers the observe-class census,
  // so prefer the shared one when both exist and take whatever is there
  // otherwise — the socket that exists is the daemon we can talk to.
  const all = files.filter((f) => f.endsWith(".sock"));
  const shared = all.filter((f) => f.startsWith("daemon-"));
  const sockets = shared.length > 0 ? shared : all;
  if (sockets.length === 0) return undefined;
  // Several sockets would mean several daemon generations; the newest socket
  // is the one the current build talks to.
  const newest = sockets
    .map((f) => {
      const full = path.join(dir, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        /* raced a cleanup; treated as oldest */
      }
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)[0];
  return newest?.full;
}

const CENSUS_TIMEOUT_MS = 5_000;

type ListApplicationsResult = {
  applications?: { name: string }[];
  invisibleApplications?: { name: string }[];
};

/**
 * Ask the daemon what is running. Unreachable is an answer, not an error:
 * the page renders installed applications either way and says the daemon is
 * not running, because a checklist that 500s when the daemon naps would make
 * the permissions page unusable exactly when the user might want to prepare
 * permissions for the daemon's next start.
 */
export async function readCensus(socketPath: string | undefined): Promise<Census> {
  if (!socketPath) {
    return { reachable: false, reason: "The desktop service is not running (no socket found)." };
  }

  return await new Promise<Census>((resolve) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const settle = (census: Census) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(census);
    };
    const timer = setTimeout(
      () => settle({ reachable: false, reason: "The desktop service did not answer in time." }),
      CENSUS_TIMEOUT_MS,
    );

    socket.once("connect", () => {
      socket.setEncoding("utf8");
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "listApplications", params: {} })}\n`);
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        try {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            result?: ListApplicationsResult;
            error?: { message?: string };
          };
          if (message.error) {
            settle({
              reachable: false,
              reason: message.error.message ?? "The desktop service refused the census.",
            });
            return;
          }
          settle({ reachable: true, applications: toCensusRows(message.result ?? {}) });
        } catch {
          settle({ reachable: false, reason: "The desktop service answered unreadably." });
        }
      });
    });
    socket.once("error", () =>
      settle({ reachable: false, reason: "The desktop service is not running." }),
    );
  });
}

function toCensusRows(result: ListApplicationsResult): CensusApplication[] {
  return [
    // On the accessibility bus: running and readable.
    ...(result.applications ?? []).map((app) => ({
      name: app.name,
      running: true as const,
      readable: true,
    })),
    // Windows the display server sees but the accessibility layer cannot:
    // running, not readable — the page's "needs a restart to become readable"
    // pill is born from exactly this distinction.
    ...(result.invisibleApplications ?? []).map((app) => ({
      name: app.name,
      running: true as const,
      readable: false,
    })),
  ];
}
