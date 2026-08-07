import { join } from "node:path";

/**
 * The per-OS knowledge that belongs to supervising a service rather than to
 * talking to one.
 *
 * Where the daemon listens moved to `clients/shared`, because every client
 * needs an address and only this one starts a process. What is left is the
 * question a supervisor alone asks.
 */

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
