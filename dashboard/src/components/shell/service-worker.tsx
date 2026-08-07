"use client";

import { useEffect } from "react";

/**
 * Registers the hub's service worker, which is what makes this page installable
 * on a phone.
 *
 * Registration is deliberately quiet. A failure here costs the install prompt
 * and nothing else — the dashboard works exactly as well without a worker — so
 * a browser that refuses (no support, an insecure origin, a user who disabled
 * workers) should not produce an error the user has to read past. The one case
 * worth naming is the common one: workers require a secure context, so over
 * plain http on a LAN address this simply does not run, and the phone will not
 * offer to install. That is a TLS problem, not a bug to chase here.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  return null;
}
