"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { AuditEntry, AuditFeed } from "@/lib/hub";
import { cn } from "@/lib/utils";

/**
 * The audit trail per the approved design: filters, a table of decisions, and
 * a detail panel for the selected one.
 *
 * Every value on this page was written by the daemon at the moment it decided,
 * already redacted — what was done, to which application, and how it went,
 * never the contents of a field. The page adds nothing but a layout and a
 * relative clock, which is exactly the point: an audit trail the viewer
 * enriches is a story about the viewer.
 */

function relativeTime(at: string | undefined, now: number): string {
  if (!at) return "—";
  const then = Date.parse(at);
  if (Number.isNaN(then)) return at;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const CLASS_TONE: Record<string, "default" | "warning" | "danger" | "muted"> = {
  observe: "default",
  edit: "warning",
  activate: "warning",
  submit: "danger",
  destructive: "danger",
};

function OperationPill(props: { operationClass?: string }) {
  if (!props.operationClass) return <span className="text-muted">—</span>;
  return (
    <Badge variant={CLASS_TONE[props.operationClass] ?? "muted"}>{props.operationClass}</Badge>
  );
}

/**
 * The outcome, in the daemon's own words. A refusal carries its reason, and
 * the reason is the half of the log worth keeping — so it is shown, not
 * summarised into a colour.
 */
function OutcomePill(props: { entry: AuditEntry }) {
  const { decision, reason } = props.entry;
  if (!decision) return <span className="text-muted">—</span>;
  const refused = decision !== "allowed" && decision !== "ok";
  return (
    <Badge
      variant={refused ? "danger" : "success"}
      className="max-w-56 truncate"
      // Truncation is a layout decision, never a redaction: the whole reason
      // is one hover away here and spelled out in the detail panel.
      title={refused && reason ? `${decision} — ${reason}` : decision}
    >
      {refused && reason ? `${decision} — ${reason}` : decision}
    </Badge>
  );
}

function DetailPanel(props: { entry: AuditEntry; onClose: () => void }) {
  const { entry } = props;
  const facts: [string, string | undefined][] = [
    ["Action", entry.method],
    ["Operation class", entry.operationClass],
    ["Application", entry.application],
    ["Client", entry.clientLabel ? `${entry.clientId} (${entry.clientLabel})` : entry.clientId],
    ["Outcome", entry.decision],
    ["Reason", entry.reason],
    ["Backend", entry.backend],
    ["Error", entry.errorCode],
    ["Duration", entry.durationMs ? `${entry.durationMs}ms` : undefined],
    ["Window", entry.windowId],
    ["Element", entry.elementId],
    ["At", entry.at],
  ];
  return (
    <Card className="h-fit w-72 shrink-0">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-lg text-foreground">Audit detail</CardTitle>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close audit detail"
          className="text-muted hover:text-foreground"
        >
          ✕
        </button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <dl className="flex flex-col gap-1.5 text-sm">
          {facts
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label} className="flex flex-col">
                <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
                <dd className="break-words">{value}</dd>
              </div>
            ))}
        </dl>
        <p className="rounded-lg border border-border bg-well/60 p-2 text-xs text-muted">
          Records carry what was done and how it went. Field contents, window titles
          and typed text are never written here.
        </p>
      </CardContent>
    </Card>
  );
}

function uniqueValues(entries: readonly AuditEntry[], key: keyof AuditEntry): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    const value = entry[key];
    if (typeof value === "string" && value) seen.add(value);
  }
  return [...seen].sort();
}

export function AuditPanel(props: { feed: AuditFeed; now?: number }) {
  const { feed } = props;
  const now = props.now ?? Date.now();
  const [application, setApplication] = useState("");
  const [client, setClient] = useState("");
  const [operationClass, setOperationClass] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | undefined>(undefined);

  const folded = query.trim().toLowerCase();
  const rows = feed.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !application || entry.application === application)
    .filter(({ entry }) => !client || entry.clientId === client)
    .filter(({ entry }) => !operationClass || entry.operationClass === operationClass)
    .filter(({ entry }) =>
      !folded
        ? true
        : [entry.method, entry.application, entry.clientId, entry.decision, entry.reason]
            .filter((value): value is string => typeof value === "string")
            .some((value) => value.toLowerCase().includes(folded)),
    )
    .reverse();

  const refusals = feed.entries.filter(
    (entry) => entry.decision && entry.decision !== "allowed" && entry.decision !== "ok",
  ).length;
  const selectedEntry = selected === undefined ? undefined : feed.entries[selected];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-foreground">Audit Trail</h1>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="w-44"
          aria-label="Filter by application"
          value={application}
          onChange={(event) => setApplication(event.target.value)}
        >
          <option value="">Application</option>
          {uniqueValues(feed.entries, "application").map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
        <Select
          className="w-44"
          aria-label="Filter by client"
          value={client}
          onChange={(event) => setClient(event.target.value)}
        >
          <option value="">Client</option>
          {uniqueValues(feed.entries, "clientId").map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
        <Select
          className="w-48"
          aria-label="Filter by operation class"
          value={operationClass}
          onChange={(event) => setOperationClass(event.target.value)}
        >
          <option value="">Operation class</option>
          {uniqueValues(feed.entries, "operationClass").map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
        <Input
          variant="pill"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the trail…"
          aria-label="Search the audit trail"
          className="w-56"
        />
        <span className="ml-auto flex items-center gap-2 text-sm">
          <Badge variant="muted">{feed.entries.length} records</Badge>
          <Badge variant={refusals > 0 ? "warning" : "muted"}>{refusals} refused</Badge>
        </span>
      </div>

      <div className="flex items-start gap-4">
        <Card className="flex-1 overflow-hidden">
          <CardContent className="p-0">
            {rows.length === 0 ? (
              <p className="p-6 text-sm text-muted">
                {feed.present
                  ? "No audit entries match. The daemon writes one line per decision, refusals included."
                  : "No audit entries yet. The daemon writes one line per decision, refusals included — this fills up the first time an agent touches the desktop."}
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                    <th className="px-4 py-2 font-medium">Timestamp</th>
                    <th className="px-4 py-2 font-medium">Client</th>
                    <th className="px-4 py-2 font-medium">Method</th>
                    <th className="px-4 py-2 font-medium">Application</th>
                    <th className="px-4 py-2 font-medium">Operation class</th>
                    <th className="px-4 py-2 font-medium">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ entry, index }) => (
                    <tr
                      key={index}
                      onClick={() => setSelected(index)}
                      className={cn(
                        "cursor-pointer border-b border-border/60 last:border-0",
                        selected === index ? "bg-accent/10" : "hover:bg-well/60",
                      )}
                    >
                      <td className="whitespace-nowrap px-4 py-2 text-muted">
                        {relativeTime(entry.at, now)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-muted">
                        {entry.clientId ?? "—"}
                      </td>
                      <td className="px-4 py-2 font-medium">{entry.method ?? "—"}</td>
                      <td className="px-4 py-2">{entry.application ?? "—"}</td>
                      <td className="px-4 py-2">
                        <OperationPill operationClass={entry.operationClass} />
                      </td>
                      <td className="px-4 py-2">
                        <OutcomePill entry={entry} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
        {selectedEntry ? (
          <DetailPanel entry={selectedEntry} onClose={() => setSelected(undefined)} />
        ) : null}
      </div>
    </div>
  );
}
