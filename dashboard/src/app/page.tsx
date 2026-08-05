"use client";

import { useEffect, useState } from "react";

import { Overview } from "@/components/overview/overview";
import { getHealth, getOrbStatus, type Fetched, type HubHealth, type OrbStatus } from "@/lib/hub";

/**
 * The Overview page. Static export means no server-side IO — the page mounts,
 * then asks the hub it is served from. Until the answers land it says so,
 * because a spinner pretending to be data is a small lie.
 */
export default function Home() {
  const [health, setHealth] = useState<Fetched<HubHealth> | null>(null);
  const [orb, setOrb] = useState<Fetched<OrbStatus> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [h, o] = await Promise.all([getHealth(), getOrbStatus()]);
      if (cancelled) return;
      setHealth(h);
      setOrb(o);
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (health === null || orb === null) {
    return <p className="text-sm text-muted">Asking the hub…</p>;
  }

  return <Overview health={health} orb={orb} />;
}
