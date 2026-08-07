"use client";

import { useEffect, useState } from "react";

import { UnreachableNotice } from "@/components/overview/overview";
import { PluginsPanel } from "@/components/plugins/plugins";
import { getHealth, type Fetched, type HubHealth } from "@/lib/hub";

/**
 * The Plugins page. The census lives on `/api/health`, so the page asks the
 * hub it is served from and renders the answer — including the answer that
 * there was none.
 */
export default function PluginsPage() {
  const [health, setHealth] = useState<Fetched<HubHealth> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getHealth().then((answer) => {
      if (!cancelled) setHealth(answer);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (health === null) {
    return <p className="text-sm text-muted">Asking the hub…</p>;
  }
  if (health.kind === "unreachable") {
    return <UnreachableNotice detail={health.detail} />;
  }

  return <PluginsPanel health={health.data} />;
}
