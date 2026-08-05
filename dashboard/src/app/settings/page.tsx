"use client";

import { useCallback, useEffect, useState } from "react";

import { UnreachableNotice } from "@/components/overview/overview";
import { SettingsPanel, type Depth } from "@/components/settings/settings";
import {
  getAutostart,
  getDesktopConfig,
  getHealth,
  putAutostart,
  putDesktopSettings,
  type AutostartView,
  type DesktopConfigView,
  type HubHealth,
} from "@/lib/hub";
import { DEPTHS } from "@/components/settings/settings";

/**
 * The Settings page: fetching, saving, and remembering which depth you chose.
 * What each depth looks like belongs to the panel; this file owns the wire.
 *
 * The depth itself is not in the configuration file, and that is on purpose.
 * The daemon has no opinion about how many fields a person likes to see, and a
 * viewing preference written into the object being viewed is a setting that
 * changes what an agent reads. It lives in this browser instead.
 */

const DEPTH_STORAGE_KEY = "mastracode.settings.depth";

function isDepth(value: unknown): value is Depth {
  return typeof value === "string" && (DEPTHS as readonly string[]).includes(value);
}

export default function SettingsPage() {
  const [view, setView] = useState<DesktopConfigView | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [health, setHealth] = useState<HubHealth | null>(null);
  const [depth, setDepth] = useState<Depth>("easy");
  const [autostart, setAutostart] = useState<AutostartView | undefined>(undefined);
  const [autostartRefusal, setAutostartRefusal] = useState<string | undefined>(undefined);
  const [autostartBusy, setAutostartBusy] = useState(false);

  useEffect(() => {
    // Read after mount: this is a static export, and localStorage does not
    // exist at build time.
    const stored = window.localStorage.getItem(DEPTH_STORAGE_KEY);
    if (isDepth(stored)) setDepth(stored);
  }, []);

  const chooseDepth = useCallback((next: Depth) => {
    setDepth(next);
    window.localStorage.setItem(DEPTH_STORAGE_KEY, next);
  }, []);

  useEffect(() => {
    void (async () => {
      const answer = await getDesktopConfig();
      if (answer.kind === "ok") setView(answer.data);
      else if (answer.kind === "refused") setRefusal(answer.detail);
      else setUnreachable(answer.detail);
    })();
    void (async () => {
      const answer = await getHealth();
      if (answer.kind === "ok") setHealth(answer.data);
    })();
    void (async () => {
      // Autostart is a different file with a different route, so it is asked
      // for separately: a hub that cannot answer about the login entry has
      // still answered about the configuration, and the lenses stay drawn.
      const answer = await getAutostart();
      if (answer.kind === "ok") setAutostart(answer.data);
    })();
  }, []);

  const flipAutostart = useCallback(async (enabled: boolean) => {
    setAutostartBusy(true);
    try {
      // The hub answers with a fresh read of the disk, and that is what the
      // switch shows — never the request echoed back.
      setAutostart(await putAutostart(enabled));
      setAutostartRefusal(undefined);
    } catch (cause) {
      setAutostartRefusal(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAutostartBusy(false);
    }
  }, []);

  const save = useCallback(async (key: string, value: unknown) => {
    // One leaf per write. The PUT answers with the whole fresh object, so the
    // answer is the reload — and a refusal leaves the view exactly as it was,
    // because a refused save changed nothing to re-read.
    const answer = await putDesktopSettings({ [key]: value });
    if (answer.kind === "ok") {
      setView(answer.data);
      setRefusal(undefined);
      return;
    }
    setRefusal(answer.kind === "refused" ? answer.detail : `The hub did not answer: ${answer.detail}`);
  }, []);

  if (unreachable !== null) return <UnreachableNotice detail={unreachable} />;
  if (view === null) {
    return refusal ? (
      <SettingsUnreadable detail={refusal} />
    ) : (
      <p className="text-sm text-muted">Asking the hub…</p>
    );
  }

  return (
    <SettingsPanel
      view={view}
      depth={depth}
      onDepth={chooseDepth}
      onSave={(key, value) => void save(key, value)}
      refusal={refusal}
      voice={health?.voice}
      orb={health?.orb}
      autostart={autostart}
      autostartRefusal={autostartRefusal}
      autostartBusy={autostartBusy}
      onFlipAutostart={(enabled) => void flipAutostart(enabled)}
    />
  );
}

/**
 * The file will not parse, so there is no object to draw lenses over. Shown
 * instead of an empty form: a form here would invite a save, and a save would
 * be the overwrite.
 */
function SettingsUnreadable(props: { detail: string }) {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
      <div className="rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
        <p className="font-medium">The configuration file could not be read.</p>
        <p className="mt-1 text-danger/90">{props.detail}</p>
        <p className="mt-2 text-xs text-danger/80">
          Nothing has been changed. The settings are not shown because showing them would mean
          guessing what the file says, and saving that guess would replace what it actually says.
          Fix the file and reload.
        </p>
      </div>
    </div>
  );
}
