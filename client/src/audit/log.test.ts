import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildAuditApp } from "./routes.ts";
import { DEFAULT_LIMIT, MAX_LIMIT, TAIL_WINDOW_BYTES, readAuditTail } from "./log.ts";

const dirs: string[] = [];

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-audit-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeLog(lines: string[]): string {
  const file = path.join(tmpdir(), "audit.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

const record = (n: number) =>
  JSON.stringify({
    v: 1,
    at: `2026-08-05T05:0${n}:00Z`,
    method: "listApplications",
    operationClass: "observe",
    clientId: `c${n}`,
    decision: "allowed",
  });

describe("reading the tail", () => {
  it("returns the last records, newest last, adding nothing", () => {
    const file = writeLog([record(1), record(2), record(3)]);

    const read = readAuditTail(file, 2);

    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.entries).toHaveLength(2);
    expect(read.entries[0]).toEqual(JSON.parse(record(2)));
    expect(read.entries[1]).toEqual(JSON.parse(record(3)));
    // The route is a pipe: every key on the way out was on the way in.
    expect(Object.keys(read.entries[1] as object).sort()).toEqual(
      Object.keys(JSON.parse(record(3)) as object).sort(),
    );
  });

  it("drops a torn final line rather than refusing the whole log", () => {
    const file = path.join(tmpdir(), "audit.jsonl");
    fs.writeFileSync(file, `${record(1)}\n{"v":1,"method":"lis`, "utf8");

    const read = readAuditTail(file);

    expect(read.kind === "ok" && read.entries).toHaveLength(1);
  });

  it("reads only the tail of a large log, and never a half line", () => {
    // Padded past the tail window so the read starts mid-line: the first
    // fragment must be dropped rather than parsed into a bogus record.
    const filler = JSON.stringify({ v: 1, method: "pad", pad: "x".repeat(2000) });
    const count = Math.ceil(TAIL_WINDOW_BYTES / filler.length) + 50;
    const file = writeLog([...Array.from({ length: count }, () => filler), record(9)]);
    expect(fs.statSync(file).size).toBeGreaterThan(TAIL_WINDOW_BYTES);

    const read = readAuditTail(file, 5);

    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.entries).toHaveLength(5);
    expect(read.entries.at(-1)).toEqual(JSON.parse(record(9)));
  });

  it("answers absent for a machine that has decided nothing yet", () => {
    const read = readAuditTail(path.join(tmpdir(), "nothing-here.jsonl"));

    expect(read.kind).toBe("absent");
  });

  it("clamps the limit at both ends", () => {
    const file = writeLog(Array.from({ length: MAX_LIMIT + 20 }, (_, i) => record(i % 10)));

    expect(readAuditTail(file, 0).kind === "ok" && readAuditTail(file, 0).kind).toBe("ok");
    const tiny = readAuditTail(file, 0);
    expect(tiny.kind === "ok" && tiny.entries).toHaveLength(1);
    const huge = readAuditTail(file, 10_000);
    expect(huge.kind === "ok" && huge.entries).toHaveLength(MAX_LIMIT);
  });
});

describe("the audit route", () => {
  it("serves the tail with the limit the caller asked for", async () => {
    const app = buildAuditApp(writeLog([record(1), record(2), record(3)]));

    const res = await app.request("/api/audit?limit=1");
    const body = (await res.json()) as { entries: unknown[]; present: boolean };

    expect(res.status).toBe(200);
    expect(body.present).toBe(true);
    expect(body.entries).toEqual([JSON.parse(record(3))]);
  });

  it("defaults the limit when the query is missing or nonsense", async () => {
    const app = buildAuditApp(writeLog(Array.from({ length: 150 }, (_, i) => record(i % 10))));

    const missing = (await (await app.request("/api/audit")).json()) as { entries: unknown[] };
    const nonsense = (await (await app.request("/api/audit?limit=banana")).json()) as {
      entries: unknown[];
    };

    expect(missing.entries).toHaveLength(DEFAULT_LIMIT);
    expect(nonsense.entries).toHaveLength(DEFAULT_LIMIT);
  });

  it("has no filename to bend: the path is fixed at construction", async () => {
    const file = writeLog([record(1)]);
    const app = buildAuditApp(file);

    // Whatever a caller puts in the query, the route reads the one file it was
    // built with. There is no request-supplied path to escape from.
    const res = await app.request("/api/audit?limit=1&path=../../../etc/passwd");
    const body = (await res.json()) as { entries: Record<string, unknown>[] };

    expect(res.status).toBe(200);
    expect(body.entries[0]?.method).toBe("listApplications");
  });

  it("answers an empty feed, not an error, when the log does not exist", async () => {
    const app = buildAuditApp(path.join(tmpdir(), "absent.jsonl"));

    const res = await app.request("/api/audit");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [], present: false });
  });
});
