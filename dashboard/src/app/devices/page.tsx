"use client";

import { useEffect, useState } from "react";

import { DevicesPanel } from "@/components/devices/devices";
import { UnreachableNotice } from "@/components/overview/overview";
import { getDevices, revokeDevice, type DevicesView, type Fetched } from "@/lib/hub";

/**
 * How often the page re-asks. A widget that starts after the hub did is
 * exactly the case this page exists to show, so it must not need a reload to
 * notice one.
 */
const POLL_MS = 5_000;

export default function DevicesPage() {
  const [state, setState] = useState<Fetched<DevicesView> | null>(null);

  const refresh = async () => setState(await getDevices());

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const next = await getDevices();
      if (!cancelled) setState(next);
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Revoking is not undoable, so it asks first — and then the list is re-read
  // from the hub rather than edited here, because the hub is the one that knows
  // whether the credential is actually gone.
  const onRevoke = (id: string) => {
    if (!window.confirm("Remove this device? It will have to be paired again to come back.")) {
      return;
    }
    void revokeDevice(id).then(refresh);
  };

  if (state === null) {
    return <p className="text-sm text-muted">Asking the hub…</p>;
  }
  if (state.kind === "unreachable") {
    return <UnreachableNotice detail={state.detail} />;
  }

  return <DevicesPanel view={state.data} onRevoke={onRevoke} />;
}
