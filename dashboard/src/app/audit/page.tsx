"use client";

import { useEffect, useState } from "react";

import { AuditPanel } from "@/components/audit/audit";
import { UnreachableNotice } from "@/components/overview/overview";
import { getAudit, type AuditFeed, type Fetched } from "@/lib/hub";

/** How often the trail re-reads the log. Slow: an audit page is not a console. */
const POLL_MS = 10_000;

/**
 * The audit page: the daemon's own log, tailed.
 *
 * Read-only in every direction. There is no route behind this page that can
 * append to the log, prune it or annotate it — the file is the daemon's
 * record of what it decided, and the dashboard is a window onto it.
 */
export default function AuditPage() {
  const [state, setState] = useState<Fetched<AuditFeed> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const next = await getAudit();
      if (!cancelled) setState(next);
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (state === null) {
    return <p className="text-sm text-muted">Asking the hub…</p>;
  }
  if (state.kind === "unreachable") {
    return <UnreachableNotice detail={state.detail} />;
  }

  return <AuditPanel feed={state.data} />;
}
