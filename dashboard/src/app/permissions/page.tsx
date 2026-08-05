"use client";

import { useCallback, useEffect, useState } from "react";

import { UnreachableNotice } from "@/components/overview/overview";
import { ConfigRefusedNotice, PermissionsPanel } from "@/components/permissions/permissions";
import { getPermissions, putAccess, type AppAccess, type PermissionsFetch } from "@/lib/hub";

/**
 * The permissions page: the user's half of #116 and #127. Choosing a state
 * here rewrites the config file the daemon's ceiling reads — the daemon
 * notices on its own, so the page's only jobs are to show the truth and send
 * exact names.
 */
export default function PermissionsPage() {
  const [state, setState] = useState<PermissionsFetch | null>(null);

  const load = useCallback(async () => {
    setState(await getPermissions());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = useCallback(async (app: string, access: Exclude<AppAccess, "custom">) => {
    // The PUT answers with the fresh merged view, so the answer IS the reload.
    setState(await putAccess(app, access));
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
    <PermissionsPanel view={state.data} onChoose={(app, access) => void choose(app, access)} />
  );
}
