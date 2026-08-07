"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { UnreachableNotice } from "@/components/overview/overview";
import { ConfigRefusedNotice, PermissionsPanel } from "@/components/permissions/permissions";
import { getPermissions, putAccess, type AppAccess, type PermissionsFetch } from "@/lib/hub";

/** How often to re-ask the hub for the census. */
const POLL_MS = 5_000;

/**
 * The permissions page: the user's half of #116 and #127. Choosing a state
 * here rewrites the config file the daemon's ceiling reads — the daemon
 * notices on its own, so the page's only jobs are to show the truth and send
 * exact names.
 *
 * Showing the truth means re-asking. The hub re-runs the census on every GET,
 * so a page that asked once at mount kept rendering the desktop as it stood
 * when it loaded — an application quit hours ago still read as running (#192).
 * The ask is chained rather than on an interval because a census against an
 * unreachable daemon can eat its full five-second timeout, and an interval
 * that fires anyway would stack sockets on a daemon already struggling.
 */
export default function PermissionsPage() {
  const [state, setState] = useState<PermissionsFetch | null>(null);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [now, setNow] = useState(0);
  /**
   * Counts the writes this page has made. A GET issued before a toggle can
   * land after the PUT that answered it, and applying it would redraw the
   * control the user just moved back to its old state.
   */
  const writes = useRef(0);

  const load = useCallback(async () => {
    const seen = writes.current;
    const next = await getPermissions();
    if (writes.current !== seen) return false;
    setState(next);
    setUpdatedAt(Date.now());
    setNow(Date.now());
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      await load();
      if (cancelled) return;
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  // Ages the stamp between polls, so "0s ago" does not sit there for five seconds.
  useEffect(() => {
    const ticking = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(ticking);
  }, []);

  const choose = useCallback(async (app: string, access: Exclude<AppAccess, "custom">) => {
    writes.current += 1;
    // The PUT answers with the fresh merged view, so the answer IS the reload.
    setState(await putAccess(app, access));
    setUpdatedAt(Date.now());
    setNow(Date.now());
  }, []);

  if (state === null) {
    return <p className="text-sm text-muted">Asking the hub…</p>;
  }
  if (state.kind === "unreachable") {
    return <UnreachableNotice detail={state.detail} />;
  }
  if (state.kind === "refused") {
    return <ConfigRefusedNotice detail={state.detail} />;
  }

  return (
    <PermissionsPanel
      view={state.data}
      onChoose={(app, access) => void choose(app, access)}
      updatedAt={updatedAt}
      now={now}
      onRefresh={() => void load()}
    />
  );
}
