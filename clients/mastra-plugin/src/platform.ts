import { join } from "node:path";

import { SCHEMA_DIGEST } from "./protocol.generated.ts";

/**
 * Where the desktop service listens, per OS.
 *
 * The port is one function — machine plus schema digest in, an address the
 * supervisor can dial out — and every OS-specific assumption about what an
 * address looks like lives below it. The digest is in the name on purpose:
 * two builds that disagree about the protocol must not find each other, and
 * making that a different address means they simply never meet, rather than
 * meeting and failing halfway through a call.
 *
 * Freedesktop and macOS both get unix sockets, differing only in where a
 * runtime directory lives. Windows has no unix domain socket a Python service
 * can bind the same way, so it gets a named pipe — the reason this is a port
 * and not a path helper.
 */

export type DaemonEndpoint = (env?: NodeJS.ProcessEnv) => string;

const SOCKET_DIR = "mastracode-desktop";

function socketName(): string {
  return `daemon-${SCHEMA_DIGEST}.sock`;
}

/**
 * `$XDG_RUNTIME_DIR`, falling back to the path systemd would have made.
 *
 * The fallback matters for sessions that arrive without the variable set — a
 * plain ssh login, most notably — where the directory usually exists anyway.
 */
export function freedesktopDaemonEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const runtimeDir = env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  return join(runtimeDir, SOCKET_DIR, socketName());
}

/**
 * macOS has no `$XDG_RUNTIME_DIR`; `$TMPDIR` is the per-user directory that
 * comes closest, being private to the user and cleared between boots.
 */
export function macosDaemonEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.TMPDIR ?? "/tmp", SOCKET_DIR, socketName());
}

/**
 * A named pipe. Not a filesystem path at all — it never touches disk, and the
 * `\\.\pipe\` prefix is the whole namespace — which is exactly why callers must
 * treat this value as opaque and never join, stat, or mkdir it.
 */
export function windowsDaemonEndpoint(): string {
  return `\\\\.\\pipe\\${SOCKET_DIR}-daemon-${SCHEMA_DIGEST}`;
}

/**
 * Whether an endpoint is a file on disk the supervisor may check for and clean
 * up. False for a named pipe, whose existence is only knowable by connecting.
 */
export function endpointIsFile(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/** The endpoint for the OS this process is running on. */
export function daemonEndpointFor(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") return windowsDaemonEndpoint();
  if (platform === "darwin") return macosDaemonEndpoint(env);
  return freedesktopDaemonEndpoint(env);
}

/**
 * The interpreter that runs the service.
 *
 * Windows puts a virtualenv's interpreter in `Scripts\python.exe` rather than
 * `bin/python`, which is the only thing separating a working spawn from a
 * confusing "service virtualenv is missing".
 */
export function venvPython(
  serviceRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32"
    ? join(serviceRoot, ".venv", "Scripts", "python.exe")
    : join(serviceRoot, ".venv", "bin", "python");
}
