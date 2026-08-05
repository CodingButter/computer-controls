import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PermissionRow, PermissionsView } from "@/lib/hub";

/**
 * The permissions checklist, rendered pure from an already-fetched view.
 * The page owns fetching and toggling; this file owns what a row looks like.
 */

function RowPills(props: { row: PermissionRow }) {
  const { row } = props;
  return (
    <span className="flex items-center gap-2">
      {row.running ? (
        <Badge variant="success">running</Badge>
      ) : (
        <Badge variant="muted">not running</Badge>
      )}
      {row.running && !row.readable ? (
        // The Chromium condition: windows on screen, nothing on the
        // accessibility bus. Curing plus a restart is what fixes it, and the
        // pill is honest about which half is the user's.
        <Badge variant="warning">needs restart to become readable</Badge>
      ) : null}
    </span>
  );
}

export function PermissionsPanel(props: {
  view: PermissionsView;
  /** Fired with the row's exact name — the ceiling matches substrings, so fragments are never sent. */
  onToggle: (app: string, permitted: boolean) => void;
}) {
  const { view, onToggle } = props;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Application permissions</CardTitle>
          <Badge variant={view.mode === "per-application" ? "default" : "warning"}>
            {view.mode === "per-application" ? "per-application" : "open — everything permitted"}
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm text-muted">
            Checked applications are the ones agents may see and act on. New applications
            arrive unpermitted: installing something never opens it to an agent until you
            say so here.
          </p>
          {view.mode === "open" ? (
            <p className="text-sm text-muted">
              This machine is in open mode — nothing has been withheld yet. The first
              toggle switches it to per-application mode and keeps everything currently
              visible permitted, minus whatever you uncheck.
            </p>
          ) : null}
          {!view.daemon.reachable ? (
            <p className="text-sm text-warning">
              The desktop service is not running: {view.daemon.reason} Showing installed
              applications; running states will appear when it is back.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col divide-y divide-border p-0">
          {view.applications.length === 0 ? (
            <p className="p-4 text-sm text-muted">
              No applications found — neither running nor installed with a launcher entry.
            </p>
          ) : (
            view.applications.map((row) => (
              <label
                key={row.name}
                className="flex cursor-pointer items-center justify-between gap-4 p-4"
              >
                <span className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={row.permitted}
                    onChange={() => onToggle(row.name, !row.permitted)}
                    className="h-4 w-4 accent-accent"
                    aria-label={`Permit ${row.name}`}
                  />
                  <span className="font-medium">{row.name}</span>
                </span>
                <RowPills row={row} />
              </label>
            ))
          )}
        </CardContent>
      </Card>
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
