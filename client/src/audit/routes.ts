import { Hono } from "hono";

import { DEFAULT_LIMIT, readAuditTail, type AuditRead } from "./log.ts";

/**
 * One route: the tail of the daemon's audit log.
 *
 * The path is fixed at construction and never arrives in a request, so there
 * is no filename for a caller to bend into a traversal — the only thing a
 * request may say is how many lines it wants back.
 */
export function buildAuditApp(auditPath: string): Hono {
  const app = new Hono();

  app.get("/api/audit", (c) => {
    const asked = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(asked) ? asked : DEFAULT_LIMIT;
    const read: AuditRead = readAuditTail(auditPath, limit);
    if (read.kind === "absent") {
      // Not a 404: the hub answered, and "nothing has been decided yet" is
      // the answer. The page says so rather than showing a failed fetch.
      return c.json({ entries: [], present: false });
    }
    return c.json({ entries: read.entries, present: true });
  });

  return app;
}
