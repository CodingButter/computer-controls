import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { AuditPanel } from "@/components/audit/audit";
import { parseAudit, type AuditFeed } from "@/lib/hub";

const NOW = Date.parse("2026-08-05T06:00:00Z");

const FEED: AuditFeed = {
  present: true,
  entries: [
    {
      at: "2026-08-05T05:59:00Z",
      method: "inspectWindow",
      operationClass: "observe",
      clientId: "client-a1b2",
      application: "Discord",
      decision: "allowed",
      durationMs: 12,
    },
    {
      at: "2026-08-05T05:55:00Z",
      method: "invokeElement",
      operationClass: "activate",
      clientId: "client-e5f6",
      application: "Slack",
      decision: "refused",
      reason: "outside the consent ceiling",
    },
  ],
};

test("the trail renders the daemon's records, refusals included", () => {
  const html = renderToStaticMarkup(<AuditPanel feed={FEED} now={NOW} />);

  expect(html).toContain("Audit Trail");
  expect(html).toContain("inspectWindow");
  expect(html).toContain("invokeElement");
  expect(html).toContain("Discord");
  expect(html).toContain("Slack");
  expect(html).toContain("observe");
  expect(html).toContain("activate");
  // A refusal keeps its reason: that half of the log is the half worth having.
  expect(html).toContain("outside the consent ceiling");
  // Relative clock, computed from the record's own timestamp.
  expect(html).toContain("1m ago");
  expect(html).toContain("5m ago");
  // The design's filters and counts.
  expect(html).toContain('aria-label="Filter by application"');
  expect(html).toContain('aria-label="Filter by client"');
  expect(html).toContain('aria-label="Filter by operation class"');
  expect(html).toContain('aria-label="Search the audit trail"');
  expect(html).toContain("2 records");
  expect(html).toContain("1 refused");
});

test("an empty log is an honest answer, not a failure", () => {
  const html = renderToStaticMarkup(
    <AuditPanel feed={{ entries: [], present: false }} now={NOW} />,
  );

  expect(html).toContain("No audit entries yet");
  expect(html).not.toContain("<table");
});

test("the page adds nothing the daemon did not write", () => {
  const parsed = parseAudit({
    entries: [
      {
        v: 1,
        at: "2026-08-05T05:59:00Z",
        method: "typeText",
        operationClass: "edit",
        clientId: "client-c3d4",
        decision: "allowed",
        // The kind of field the daemon never writes, planted here to prove the
        // parser drops what is not on its list rather than carrying it through.
        typedText: "my banking password",
      },
    ],
    present: true,
  });

  expect(parsed.entries[0]).not.toHaveProperty("typedText");
  expect(parsed.entries[0]?.method).toBe("typeText");

  const html = renderToStaticMarkup(<AuditPanel feed={parsed} now={NOW} />);
  expect(html).not.toContain("banking");
});

test("parsing refuses a body that is not an audit answer", () => {
  expect(() => parseAudit({ nope: true })).toThrow();
  expect(parseAudit({ entries: [1, "two", null] }).entries).toEqual([]);
});
