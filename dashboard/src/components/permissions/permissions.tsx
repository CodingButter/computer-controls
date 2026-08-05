"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { AppAccess, PermissionRow, PermissionsView } from "@/lib/hub";
import { cn } from "@/lib/utils";

/** The states a person can choose, in the order they widen. */
const CHOICES: { value: Exclude<AppAccess, "custom">; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Not permitted at all" },
  { value: "view", label: "View only", hint: "Read the window; change nothing" },
  { value: "interact", label: "Interact", hint: "Read and act — viewing is included" },
];

/**
 * The three-state control, and the page's whole answer to #127.
 *
 * A segmented radio group rather than two switches, because "view only" and
 * "interact" are one question with three answers and not two independent
 * flags — a pair of switches would let a person ask for interaction without
 * viewing, which is a state the daemon will not hold and nobody means.
 */
function AccessControl(props: {
  row: PermissionRow;
  onChoose: (app: string, access: Exclude<AppAccess, "custom">) => void;
  /** The widest any application can be here — `scopes.operationClasses`. */
  ceiling: readonly string[];
  className?: string;
}) {
  const { row, onChoose } = props;
  // A desktop whose global classes stop at `observe` has no interactive
  // application in it. Offering the button would offer a write that lands in
  // the file and changes nothing the daemon does.
  const interactReachable = props.ceiling.some((entry) => entry !== "observe");
  return (
    <div
      role="radiogroup"
      aria-label={`Access for ${row.name}`}
      className={cn("flex rounded-full border border-border bg-well p-0.5", props.className)}
      onClick={(event) => event.stopPropagation()}
    >
      {CHOICES.map((choice) => {
        const unreachable = choice.value === "interact" && !interactReachable;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={row.access === choice.value}
            disabled={unreachable}
            title={
              unreachable
                ? "This desktop's operation classes stop at observe, so no application can be interacted with."
                : choice.hint
            }
            onClick={() => onChoose(row.name, choice.value)}
            className={cn(
              "rounded-full px-3 py-0.5 text-xs transition-colors",
              row.access === choice.value
                ? "bg-accent font-medium text-well"
                : "text-muted hover:text-foreground",
              unreachable && "cursor-not-allowed opacity-40 hover:text-muted",
            )}
          >
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The honest label for a row whose config says something this page cannot.
 * Shown instead of silently rounding to the nearest button.
 */
function CustomClassesNote(props: { row: PermissionRow }) {
  if (props.row.access !== "custom") return null;
  return (
    <p className="text-xs text-muted">
      Set by hand in the config file to {props.row.classes?.join(", ") || "nothing"}. Choosing
      one of the three above replaces it.
    </p>
  );
}

/**
 * The permissions page per the approved design: heading, mode control, the
 * unpermitted-by-default banner, a searchable list of switch rows, and a
 * detail panel for the selected application. Rendered pure from an
 * already-fetched view — the page owns fetching and toggling; this file owns
 * what the design looks like.
 */

/**
 * The design's leading icon slot: the application's real launcher icon,
 * served by the hub from the machine's own icon themes. An app with no
 * launcher entry — or whose icon the hub cannot find — falls back to its
 * initial, so the row always reads the same shape.
 */
function AppAvatar(props: { name: string; desktopId?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = props.desktopId
    ? `/api/permissions/icon/${encodeURIComponent(props.desktopId)}`
    : undefined;
  if (src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- same-origin runtime asset; next/image has no place in a static export
      <img
        src={src}
        alt=""
        aria-hidden
        onError={() => setFailed(true)}
        className={cn("h-8 w-8 shrink-0 rounded-lg object-contain", props.className)}
      />
    );
  }
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
  if (row.access === "view") return <Badge variant="muted">View only</Badge>;
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

function DetailPanel(props: {
  row: PermissionRow;
  onChoose: (app: string, access: Exclude<AppAccess, "custom">) => void;
  ceiling: readonly string[];
}) {
  const { row, onChoose } = props;
  return (
    <Card className="h-fit w-72 shrink-0">
      <CardHeader className="flex-row items-center gap-3">
        <AppAvatar name={row.name} desktopId={row.desktopId} className="h-10 w-10 text-base" />
        <CardTitle className="text-lg text-foreground">{row.name}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <span className="text-sm text-muted">Access</span>
          <AccessControl row={row} onChoose={onChoose} ceiling={props.ceiling} className="self-start" />
          <CustomClassesNote row={row} />
        </div>
        {row.access === "interact" ? (
          <p className="text-xs text-muted">
            Interacting includes viewing: an agent permitted to click a control it could not
            read would be clicking blind.
          </p>
        ) : null}
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
  onChoose: (app: string, access: Exclude<AppAccess, "custom">) => void;
}) {
  const { view, onChoose } = props;
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
        <Input
          variant="pill"
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search applications…"
          aria-label="Search applications"
          className="w-64"
        />
      </div>

      <div className="rounded-lg border border-accent/40 bg-accent/10 px-4 py-2.5 text-sm text-foreground">
        New applications arrive unpermitted. Nothing an agent does can widen this list.
      </div>

      {!view.ceiling.some((entry) => entry !== "observe") ? (
        <p className="text-sm text-muted">
          This desktop&rsquo;s operation classes stop at observe, so every permitted
          application is view-only whatever is chosen here. Widening that is a change to{" "}
          <code>scopes.operationClasses</code> in the config file, which this page does not
          own.
        </p>
      ) : null}
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
                <AppAvatar name={row.name} desktopId={row.desktopId} />
                <span className="flex-1 truncate font-medium">{row.name}</span>
                <AccessControl row={row} onChoose={onChoose} ceiling={view.ceiling} />
                {row.access === "custom" ? <Badge variant="warning">Custom</Badge> : null}
                <span className="flex w-64 justify-end">
                  <AccessPill row={row} />
                </span>
              </div>
            ))
          )}
        </div>
        {selectedRow ? (
          <DetailPanel row={selectedRow} onChoose={onChoose} ceiling={view.ceiling} />
        ) : null}
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
