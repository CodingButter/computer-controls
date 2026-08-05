/** /api/audit — the daemon's decision log, read and never enriched. */

import { fetchJson, type Fetched } from "./core";

/**
 * One audit record, as the daemon wrote it.
 *
 * Every field is optional because the daemon omits what it has nothing to say
 * about, and the record carries its own version — a page that demanded today's
 * shape would go blank against tomorrow's daemon. What is deliberately absent
 * everywhere: element values, window titles, typed text. The log was redacted
 * where it was written, and nothing on this path un-redacts it.
 */
export type AuditEntry = {
  at?: string;
  method?: string;
  operationClass?: string;
  clientId?: string;
  clientLabel?: string;
  decision?: string;
  reason?: string;
  application?: string;
  windowId?: string;
  elementId?: string;
  backend?: string;
  errorCode?: string;
  durationMs?: number;
};

export type AuditFeed = {
  entries: readonly AuditEntry[];
  /** False when the daemon has not written a log yet — an answer, not a failure. */
  present: boolean;
};

const AUDIT_STRINGS = [
  "at",
  "method",
  "operationClass",
  "clientId",
  "clientLabel",
  "decision",
  "reason",
  "application",
  "windowId",
  "elementId",
  "backend",
  "errorCode",
] as const;

export function parseAudit(body: unknown): AuditFeed {
  if (typeof body !== "object" || body === null || !("entries" in body)) {
    throw new Error("not an audit response");
  }
  const raw = body as Record<string, unknown>;
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .map((row) => {
      // Copied field by field, by name. The same allowlist discipline the
      // daemon uses on the way out: a field a future daemon adds does not
      // ride into the page unnoticed.
      const entry: AuditEntry = {};
      for (const key of AUDIT_STRINGS) {
        const value = row[key];
        if (typeof value === "string" && value.length > 0) entry[key] = value;
      }
      if (typeof row.durationMs === "number") entry.durationMs = row.durationMs;
      return entry;
    });
  return { entries, present: raw.present !== false };
}

export function getAudit(limit = 100): Promise<Fetched<AuditFeed>> {
  return fetchJson(`/api/audit?limit=${encodeURIComponent(String(limit))}`, parseAudit);
}
