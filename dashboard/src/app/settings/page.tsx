"use client";

import { useCallback, useEffect, useState } from "react";

import { UnreachableNotice } from "@/components/overview/overview";
import { SettingsPanel } from "@/components/settings/settings";
import { getAutostart, putAutostart, type AutostartView, type Fetched } from "@/lib/hub";

export default function SettingsPage() {
  const [state, setState] = useState<Fetched<AutostartView> | null>(null);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getAutostart().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const flip = useCallback(async (enabled: boolean) => {
    setBusy(true);
    try {
      // The hub answers with a fresh read of the disk, and that is what the
      // switch shows — never the request echoed back.
      setState({ kind: "ok", data: await putAutostart(enabled) });
      setRefusal(undefined);
    } catch (cause) {
      setRefusal(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  if (state === null) {
    return <p className="text-sm text-muted">Asking the hub…</p>;
  }
  if (state.kind === "unreachable") {
    return <UnreachableNotice detail={state.detail} />;
  }

  return (
    <SettingsPanel
      autostart={state.data}
      autostartRefusal={refusal}
      autostartBusy={busy}
      onFlipAutostart={(enabled) => void flip(enabled)}
    />
  );
}
