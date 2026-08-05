import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The daemon's audit log, read back for the dashboard's audit page.
 *
 * The daemon writes one JSON record per line for every call it decided on,
 * refusals included, and it writes them already redacted: no element values,
 * no window titles, no typed text. That property is the daemon's, and this
 * reader keeps it by adding nothing. Every field the page shows was written by
 * the process that made the decision; the hub is a pipe with a tail on it.
 *
 * Read-only by construction. There is no route here that appends, rotates or
 * prunes — a log the reader can edit is a log with a story to tell about the
 * one line that is missing.
 */

/** Mirrors the daemon's own resolution: XDG_STATE_HOME, else ~/.local/state. */
export function defaultAuditPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "mastracode-desktop", "audit.jsonl");
}

/**
 * One record, exactly as the daemon wrote it.
 *
 * Deliberately untyped past "an object": the record version travels in the
 * payload (`v`), and a hub that insisted on today's field set would drop the
 * fields a newer daemon adds. The page renders what it recognises and shows
 * the rest as it found it.
 */
export type AuditEntry = Record<string, unknown>;

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

/**
 * How much of the file's end to read. Generous enough that MAX_LIMIT records
 * fit several times over, small enough that a log grown to megabytes does not
 * become a page load.
 */
export const TAIL_WINDOW_BYTES = 1_000_000;

export type AuditRead =
  | { kind: "ok"; entries: AuditEntry[] }
  /** No log yet — an honest answer, not an error: the daemon has not decided anything. */
  | { kind: "absent"; path: string };

/**
 * The last `limit` records, newest last, as the file has them.
 *
 * A line that does not parse is dropped rather than thrown on: the daemon
 * appends while this reads, so the final line can be half-written, and one
 * torn line is not a reason to refuse the other ninety-nine.
 */
export function readAuditTail(auditPath: string, limit = DEFAULT_LIMIT): AuditRead {
  let raw: string;
  let partialFirstLine = false;
  let handle: number;
  try {
    handle = fs.openSync(auditPath, "r");
  } catch {
    return { kind: "absent", path: auditPath };
  }
  try {
    // The log is append-only and unpruned — it reaches megabytes on a machine
    // that has been running a while, and a page that polls has no business
    // reading all of it to show the last hundred lines. Read the tail window
    // and drop whatever line it landed in the middle of.
    const { size } = fs.fstatSync(handle);
    const start = Math.max(0, size - TAIL_WINDOW_BYTES);
    partialFirstLine = start > 0;
    const buffer = Buffer.alloc(size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    raw = buffer.toString("utf8");
  } catch {
    return { kind: "absent", path: auditPath };
  } finally {
    fs.closeSync(handle);
  }

  const bounded = Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
  const all = raw.split("\n").filter((line) => line.trim().length > 0);
  const lines = partialFirstLine ? all.slice(1) : all;
  const entries: AuditEntry[] = [];
  for (const line of lines.slice(-bounded)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      entries.push(parsed as AuditEntry);
    }
  }
  return { kind: "ok", entries };
}
