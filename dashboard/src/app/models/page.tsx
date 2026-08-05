"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ModelsPanel } from "@/components/models/models";
import { UnreachableNotice } from "@/components/overview/overview";
import {
  completeLogin,
  disconnectProvider,
  getFlows,
  getHealth,
  getRealtimeSettings,
  getVoiceProviders,
  pollLogin,
  putRealtimeSettings,
  saveApiKey,
  startLogin,
  type Fetched,
  type ModelPack,
  type LoginFlow,
  type ProviderFlow,
  type RealtimeSettings,
  type VoiceProvider,
} from "@/lib/hub";

/**
 * The models page: a driver over the sign-in routes the hub already had.
 * It starts flows, waits on them at the pace the server asks for, and
 * re-reads the provider list when one lands. It holds no credential, because
 * none of these answers carry one.
 */
export default function ModelsPage() {
  const [providers, setProviders] = useState<Fetched<readonly ProviderFlow[]> | null>(null);
  const [voices, setVoices] = useState<readonly VoiceProvider[]>([]);
  const [pack, setPack] = useState<ModelPack | undefined>(undefined);
  const [flow, setFlow] = useState<LoginFlow | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [realtime, setRealtime] = useState<RealtimeSettings | undefined>(undefined);
  const [realtimeError, setRealtimeError] = useState<string | undefined>(undefined);
  const [realtimeBusy, setRealtimeBusy] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async () => {
    setProviders(await getFlows());
    const voiceAnswer = await getVoiceProviders();
    setVoices(voiceAnswer.kind === "ok" ? voiceAnswer.data : []);
    const health = await getHealth();
    setPack(health.kind === "ok" ? health.data.model : undefined);
    const settings = await getRealtimeSettings();
    if (settings.kind === "ok") {
      setRealtime(settings.data);
      setRealtimeError(undefined);
    } else {
      // The pickers are hidden rather than shown empty: an empty picker reads
      // as "nothing to choose", and the truth is that nobody was asked.
      setRealtime(undefined);
      setRealtimeError(settings.detail);
    }
  }, []);

  /**
   * Save one field and take the hub's answer as the new truth.
   *
   * The state is set from the response, never from the value that was picked,
   * so the page cannot show a setting the file does not hold — including the
   * warning the hub attaches to a value its catalog does not name.
   */
  const choose = useCallback(async (patch: { model?: string } | { voice?: string }) => {
    setRealtimeBusy(true);
    try {
      setRealtime(await putRealtimeSettings(patch));
      setRealtimeError(undefined);
    } catch (cause) {
      setRealtimeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRealtimeBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => clearTimeout(pollTimer.current);
  }, [refresh]);

  const land = useCallback(
    (next: LoginFlow) => {
      if (next.status === "complete") {
        setFlow(undefined);
        void refresh();
        return;
      }
      if (next.status === "failed") {
        setError(next.error ?? "Sign-in failed.");
        return;
      }
      setFlow(next);
      if (next.userCode) {
        // The device flow: the person types the code over there while we ask
        // here, at the pace the server asked for and no faster.
        pollTimer.current = setTimeout(() => {
          void pollLogin(next.sessionId)
            .then(land)
            .catch((cause: unknown) => setError(String(cause)));
        }, next.nextPollMs ?? 2000);
      }
    },
    [refresh],
  );

  const guard = useCallback(async (work: () => Promise<void>) => {
    setError(undefined);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  if (providers === null) {
    return <p className="text-sm text-muted">Asking the hub…</p>;
  }
  if (providers.kind === "unreachable") {
    return <UnreachableNotice detail={providers.detail} />;
  }

  return (
    <ModelsPanel
      providers={providers.data}
      voices={voices}
      pack={pack}
      flow={flow}
      error={error}
      realtime={realtime}
      realtimeError={realtimeError}
      realtimeBusy={realtimeBusy}
      onChooseRealtimeModel={(model) => void choose({ model })}
      onChooseRealtimeVoice={(voice) => void choose({ voice })}
      onConnect={(provider) => void guard(async () => land(await startLogin(provider)))}
      onDisconnect={(provider) =>
        void guard(async () => {
          await disconnectProvider(provider);
          await refresh();
        })
      }
      onSaveKey={(provider, key) =>
        void guard(async () => {
          await saveApiKey(provider, key);
          await refresh();
        })
      }
      onSubmitCode={(code) =>
        void guard(async () => {
          if (flow) land(await completeLogin(flow.sessionId, code));
        })
      }
      onCancelFlow={() => {
        clearTimeout(pollTimer.current);
        setFlow(undefined);
        setError(undefined);
      }}
    />
  );
}
