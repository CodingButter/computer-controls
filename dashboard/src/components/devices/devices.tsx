"use client";

import { CircleDot as CircleDotIcon, Monitor as MonitorIcon, Smartphone as SmartphoneIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PairPanel } from "@/components/devices/pair-panel";
import type { DeviceView, DevicesView } from "@/lib/hub";
import { cn } from "@/lib/utils";

/**
 * The devices page: what is talking to this hub, and why nothing else can yet.
 *
 * Everything drawn here was already decided by the hub. The rows arrive with
 * their own sentences and this file adds no second opinion — no last-seen
 * clock, no address, no hostname, nothing derived from the network. The hub
 * deliberately mints no identifier the product did not already generate, and a
 * page that annotated these rows with what it could sniff would undo that in
 * the one place a person goes to ask what is connected.
 */

/** The mark at the head of a row: a shape per kind, never a photograph of the machine. */
function DeviceMark(props: { kind: string; connected: boolean }) {
  const Glyph = props.kind === "hub" ? MonitorIcon : props.kind === "widget" ? CircleDotIcon : SmartphoneIcon;
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
        props.connected ? "bg-accent/15 text-accent" : "bg-well text-muted",
      )}
    >
      <Glyph className="h-4 w-4" />
    </span>
  );
}

function DeviceRow(props: { device: DeviceView; onRevoke?: (id: string) => void }) {
  const { device } = props;
  // A control appears only where the hub said there is something to revoke and
  // gave a handle to revoke it with. The page never decides removability.
  const revocable = device.removable && typeof device.id === "string";
  return (
    <li
      data-testid="device-row"
      className="flex items-start gap-3 rounded-xl border border-border bg-well/40 p-3"
    >
      <DeviceMark kind={device.kind} connected={device.connected} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{device.name}</span>
          <Badge variant={device.connected ? "success" : "muted"}>
            {device.connected ? "Connected" : "Not connected"}
          </Badge>
        </div>
        {/* The hub's sentence, verbatim. It knows why; the page does not. */}
        <p className="text-sm text-muted">{device.detail}</p>
      </div>
      {revocable && props.onRevoke ? (
        <button
          type="button"
          onClick={() => props.onRevoke?.(device.id!)}
          className="shrink-0 self-center rounded-lg border border-border px-2 py-1 text-xs text-muted transition hover:border-danger hover:text-danger"
        >
          Remove
        </button>
      ) : null}
    </li>
  );
}

export function DevicesPanel(props: { view: DevicesView; onRevoke?: (id: string) => void }) {
  const { devices, pairing } = props.view;
  const connected = devices.filter((device) => device.connected).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold text-foreground">Devices</h1>
        <p className="text-sm text-muted">
          {connected} of {devices.length} connected
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg text-foreground">Talking to this hub</CardTitle>
        </CardHeader>
        <CardContent>
          {devices.length === 0 ? (
            <p className="text-sm text-muted">
              This hub listed nothing at all, which should not happen: the machine it runs
              on is always the first device on the list.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {devices.map((device) => (
                <DeviceRow
                  key={device.id ?? `${device.kind}:${device.name}`}
                  device={device}
                  onRevoke={props.onRevoke}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg text-foreground">Pair another device</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {pairing.enabled ? (
            <PairPanel />
          ) : (
            <>
              {/* Off with a reason rather than a button that fails when pressed. */}
              <Badge variant="muted" className="self-start">
                Not available yet
              </Badge>
              <p className="text-sm text-muted">{pairing.reason}</p>
            </>
          )}
        </CardContent>
      </Card>

      <p className="rounded-xl border border-border bg-well/60 p-3 text-xs text-muted">
        This page names nothing the product did not already generate. There is no
        hostname here, no address and no scan of the network — a page that answers
        &ldquo;what is connected&rdquo; must not become the thing that fingerprints the
        machine it runs on.
      </p>
    </div>
  );
}
