"use client";

import { useEffect, useState } from "react";

import { UnreachableNotice } from "@/components/overview/overview";
import { WakeTraining } from "@/components/voice/wake-training";
import { getWakeTemplates, type WakeTemplatesView } from "@/lib/hub";

/**
 * The Voice page: what this hub listens for, and whose voice it listens with.
 *
 * The training itself belongs to the panel. This file owns the wire — one read
 * of what the hub already holds, so the panel can tell a first enrolment from a
 * replacement, and the honest unreachable state when the hub is not answering.
 */
export default function VoicePage() {
  const [current, setCurrent] = useState<WakeTemplatesView | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const answer = await getWakeTemplates();
      if (answer.kind === "ok") setCurrent(answer.data);
      else setUnreachable(answer.detail);
    })();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-fg">Voice</h1>
        <p className="text-sm text-muted">
          The orb wakes on the shape of a phrase, not on a transcript of it. Train it here and
          every surface with a microphone — this page, the widget on your desk — compares against
          the same voice.
        </p>
      </header>

      {unreachable ? <UnreachableNotice detail={unreachable} /> : null}

      <WakeTraining current={current} />
    </div>
  );
}
