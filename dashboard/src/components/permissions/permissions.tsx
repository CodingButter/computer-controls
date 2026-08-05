"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { PermissionRow, PermissionsView } from "@/lib/hub";
import { cn } from "@/lib/utils";

/**
 * The permissions page per the approved design: heading, mode control, the
 * unpermitted-by-default banner, a searchable list of switch rows, and a
 * detail panel for the selected application. Rendered pure from an
 * already-fetched view — the page owns fetching and toggling; this file owns
 * what the design looks like.
 */

/** The design's leading icon slot. Real launcher icons are a follow-up; until
 * then the slot holds the application's initial so the row reads the same. */
function AppAvatar(props: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-sm font-semibold text-accent",
        props.className,
      )}
    >
      {props.name.charAt(0).toUpperCase()}
    </span>
  );
}

/** Right-hand accessibility status, honest to the data this wave has. */
function AccessPill(props: { row: PermissionRow }) {
  const { row } = props;
  if (!row.permitted) return <Badge variant="muted">Not permitted</Badge>;
  if (row.running && !row.readable) {
    // The Chromium condition: windows on screen, nothing on the accessibility
    // bus. Curing plus a restart fixes it, and the pill is honest about which
    // half is the user's.
    return <Badge variant="warning">Needs accessibility cure — restart required</Badge>;
  }
  if (row.running && row.readable) return <Badge variant="success">Readable</Badge>;
  return null;
}

function ModeControl(props: { mode: PermissionsView["mode"] }) {
  // A status control, not a switch: per-application arrives via the first
  // toggle, and there is deliberately no one-click road back to open mode.
  const per = props.mode === "per-application";
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted">Mode:</span>
      <div className="flex rounded-full border border-border bg-well p-0.5" role="status">
        <span
          className={cn(
            "rounded-full px-3 py-0.5 text-xs",
            !per ? "bg-accent font-medium text-well" : "text-muted",
          )}
        >
          Open
        </span>
        <span
          className={cn(
            "rounded-full px-3 py-0.5 text-xs",
            per ? "bg-accent font-medium text-well" : "text-muted",
          )}
        >
          Per-application
        </span>
      </div>
    </div>
  );
}

function DetailPanel(props: { row: PermissionRow; onToggle: (app: string, permitted: boolean) => void }) {
  const { row, onToggle } = props;
  return (
    <Card className="h-fit w-72 shrink-0">
      <CardHeader className="flex-row items-center gap-3">
        <AppAvatar name={row.name} className="h-10 w-10 text-base" />
        <CardTitle className="text-lg text-foreground">{row.name}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted">Permitted</span>
          <Switch
            checked={row.permitted}
            onCheckedChange={(next) => onToggle(row.name, next)}
            aria-label={`Permit ${row.name}`}
          />
        </div>
        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Running</dt>
            <dd>{row.running ? "yes" : "no"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">On the accessibility bus</dt>
            <dd>{row.readable ? "yes" : "no"}</dd>
          </div>
          {row.desktopId ? (
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Launcher</dt>
              <dd className="truncate text-right text-xs text-muted">{row.desktopId}</dd>
            </div>
          ) : null}
        </dl>
        {row.permitted && row.running && !row.readable ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
            This application is running but invisible to the accessibility layer.
            It needs its launch shortcut cured and a restart to become readable.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function PermissionsPanel(props: {
  view: PermissionsView;
  /** Fired with the row's exact name — the ceiling matches substrings, so fragments are never sent. */
  onToggle: (app: string, permitted: boolean) => void;
}) {
  const { view, onToggle } = props;
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | undefined>(undefined);

  const folded = filter.trim().toLowerCase();
  const rows = folded
    ? view.applications.filter((row) => row.name.toLowerCase().includes(folded))
    : view.applications;
  const selectedRow =
    view.applications.find((row) => row.name === selected) ??
    rows.find((row) => row.running) ??
    rows[0];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-foreground">Application Permissions</h1>

      <div className="flex items-center justify-between gap-4">
        <ModeControl mode={view.mode} />
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search applications…"
          aria-label="Search applications"
          className="w-64 rounded-full border border-accent/40 bg-well px-4 py-1.5 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      <div className="rounded-lg border border-accent/40 bg-accent/10 px-4 py-2.5 text-sm text-foreground">
        New applications arrive unpermitted. Nothing an agent does can widen this list.
      </div>

      {view.mode === "open" ? (
        <p className="text-sm text-muted">
          This machine is in open mode — nothing has been withheld yet. The first toggle
          switches it to per-application mode and keeps everything currently visible
          permitted, minus whatever you switch off.
        </p>
      ) : null}
      {!view.daemon.reachable ? (
        <p className="text-sm text-warning">
          The desktop service is not running: {view.daemon.reason} Showing installed
          applications; running states will appear when it is back.
        </p>
      ) : null}

      <div className="flex items-start gap-4">
        <div className="flex flex-1 flex-col gap-2">
          {rows.length === 0 ? (
            <p className="p-4 text-sm text-muted">
              No applications match — neither running nor installed with a launcher entry.
            </p>
          ) : (
            rows.map((row) => (
              <div
                key={row.name}
                onClick={() => setSelected(row.name)}
                className={cn(
                  "flex cursor-pointer items-center gap-4 rounded-xl border bg-card px-4 py-2.5",
                  selectedRow?.name === row.name
                    ? "border-accent/60"
                    : "border-border hover:border-accent/30",
                )}
              >
                <AppAvatar name={row.name} />
                <span className="flex-1 truncate font-medium">{row.name}</span>
                <Switch
                  checked={row.permitted}
                  onCheckedChange={(next) => onToggle(row.name, next)}
                  aria-label={`Permit ${row.name}`}
                />
                {row.permitted ? <Badge variant="default">Permitted</Badge> : null}
                <span className="flex w-64 justify-end">
                  <AccessPill row={row} />
                </span>
              </div>
            ))
          )}
        </div>
        {selectedRow ? <DetailPanel row={selectedRow} onToggle={onToggle} /> : null}
      </div>
    </div>
  );
}

/** The 409 state: the user's hand-written config refused to parse. */
export function ConfigRefusedNotice(props: { detail: string }) {
  return (
    <Card className="border-danger/40">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Permissions</CardTitle>
        <Badge variant="danger">config refused</Badge>
      </CardHeader>
      <CardContent>
        <p className="text-sm">
          The hub refused to read the permissions config rather than guess at it:
        </p>
        <p className="mt-1 text-sm text-muted">{props.detail}</p>
        <p className="mt-2 text-sm text-muted">
          Fix the file by hand and this page will pick it up — nothing here will ever
          overwrite a config it cannot read.
        </p>
      </CardContent>
    </Card>
  );
}
