"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { AutostartView } from "@/lib/hub";

/**
 * The settings page's first real card: start on boot.
 *
 * The toggle edits the person's own autostart entry through the hub, and the
 * session manager does the launching — nothing here starts a process. The
 * state drawn is always the hub's answer, never an optimistic flip: a switch
 * showing "on" while the disk said otherwise would be the page disagreeing
 * with the desktop about what happens at login. So the card holds no state of
 * its own; the page passes the hub's latest word and takes the press back.
 *
 * A refused change renders the hub's sentence verbatim beside the switch. The
 * hub is the only side that knows why, and a page that re-phrased it would be
 * inventing a second answer. Unsupported is the reason arm pairing uses: off
 * with a sentence, never a switch that fails when pressed.
 */
export function AutostartCard(props: {
  view: AutostartView;
  refusal?: string;
  busy: boolean;
  onFlip: (enabled: boolean) => void;
}) {
  const { view } = props;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg text-foreground">Start on boot</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {view.supported ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">
                Start the Mastra CC widget when you sign in. Your desktop does the
                launching; this only writes the entry it reads.
              </p>
              <Switch
                checked={view.enabled}
                onCheckedChange={(next) => {
                  if (!props.busy) props.onFlip(next);
                }}
                aria-label="Start the widget on boot"
              />
            </div>
            {/* The file being edited, named, because it is the person's own. */}
            <p className="font-mono text-xs text-muted">{view.path}</p>
            {props.refusal === undefined ? null : (
              <p className="text-sm text-danger" role="alert">
                {props.refusal}
              </p>
            )}
          </>
        ) : (
          <>
            <Badge variant="muted" className="self-start">
              Not available here
            </Badge>
            <p className="text-sm text-muted">{view.reason}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function SettingsPanel(props: {
  autostart: AutostartView;
  autostartRefusal?: string;
  autostartBusy: boolean;
  onFlipAutostart: (enabled: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
      <AutostartCard
        view={props.autostart}
        refusal={props.autostartRefusal}
        busy={props.autostartBusy}
        onFlip={props.onFlipAutostart}
      />
      <p className="rounded-xl border border-border bg-well/60 p-3 text-xs text-muted">
        Hub configuration at every depth — Easy, Standard, and Advanced lenses over
        one configuration object — arrives here next.
      </p>
    </div>
  );
}
