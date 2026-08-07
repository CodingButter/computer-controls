import fs from "node:fs";
import path from "node:path";

import { SOCKET_DIR, runtimeDir } from "./endpoint.ts";

/**
 * Finding a daemon that is already listening.
 *
 * The counterpart to `endpoint.ts`, and the opposite question. A supervisor
 * about to start a service needs the address this build would bind, digest and
 * all. A client that only wants to ask something needs whatever daemon is
 * actually there — so rather than baking a copy of the digest into the search,
 * this looks for the sockets that exist. The socket that exists is the daemon
 * we can talk to.
 */
export function findDaemonSocket(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.MASTRACODE_DESKTOP_SOCKET) return env.MASTRACODE_DESKTOP_SOCKET;
  const dir = path.join(runtimeDir(env), SOCKET_DIR);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  // A shared daemon listens on daemon-<digest>.sock; a supervised session
  // daemon listens on mc-<pid>.sock. Either answers an observe-class question,
  // so prefer the shared one when both exist and take whatever is there
  // otherwise.
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
