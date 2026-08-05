/**
 * The orb lane, assembled and mounted.
 *
 * The lane is deliberately inert until three things are true: there is a Google
 * credential, an audio capture source exists, and a realtime provider has been
 * supplied. Any of them missing is a refusal with a reason, not a crash and not
 * a half-built orb — the page reads the reason and says it, and the typed chat
 * carries on working either way.
 *
 * `provider` and `capture` are injected rather than constructed here because
 * neither has a shipping implementation yet: `@mastra/voice-google-gemini-live-api`
 * is not on npm, and OS-level audio capture arrives with the widget work in
 * #107. Both are interfaces with tests against them, so the day either lands it
 * implements the seam and nothing above this file moves.
 */

import { Hono } from "hono";

import type { AgentTurn } from "../chat.ts";
import { createHubBrain } from "./brain.ts";
import { isRefusal, resolveOrbCredential } from "./credentials.ts";
import type { Classifier, LocalEar, VoiceActivityDetector, WakeWordDetector } from "./ear.ts";
import { realtimeConfig, type RealtimeProvider } from "./live.ts";
import { Mouth } from "./mouth.ts";
import { Orb, type OrbEvent, type Speaker } from "./orb.ts";
import { buildRealtimeSettingsApp, readRealtimeSettings } from "./realtime-settings.ts";
import { buildOrbApp, ORB_BASE_PATH } from "./routes.ts";
import { UtteranceBank, type ClipStore } from "./utterance-bank.ts";

export { ORB_BASE_PATH, GESTURES, parseGesture, buildOrbApp } from "./routes.ts";
export { GOOGLE_PROVIDER_ID, resolveOrbCredential, orbAvailability } from "./credentials.ts";
export { WakeGate, DEFAULT_QUIET_PERIOD_MS } from "./gate.ts";
export { Orb } from "./orb.ts";
export { Mouth } from "./mouth.ts";
export { UtteranceBank, CLIP_TEXT, clipClassFor } from "./utterance-bank.ts";
export { createWakeWordClassifier, isActionable, WAKE_WORDS } from "./ear.ts";
export { HUB_FUNCTION_NAME, REALTIME_TOOLS, LIVE_MODEL, realtimeConfig } from "./live.ts";
export { createHubBrain } from "./brain.ts";
export { OrbFaceSource, chooseFaceSource, toStateEvent } from "./face-source.ts";

export type { OrbEvent, OrbState, Speaker, HubBrain } from "./orb.ts";
export type { OrbFaceDeps, LiveOrbMount } from "./face-source.ts";
export type { AudioFrame, LocalEar, VoiceActivityDetector, WakeWordDetector, Classifier, IntentClass, Hearing } from "./ear.ts";
export type { RealtimeProvider, RealtimeSession, FunctionCall } from "./live.ts";
export type { Clip, ClipStore, ClipSynthesizer } from "./utterance-bank.ts";

/** The parts of the ear chain a machine has to supply for the orb to run. */
export type EarChain = {
  vad: VoiceActivityDetector;
  wakeWord: WakeWordDetector;
  ear: LocalEar;
  classifier: Classifier;
};

export type OrbMountOptions = {
  credentials: Parameters<typeof resolveOrbCredential>[0];
  turn: AgentTurn;
  clips: ClipStore;
  speaker: Speaker;
  /** Absent on a machine with no realtime provider wired yet. */
  provider?: RealtimeProvider;
  /** Absent until OS-level capture lands with the widget work. */
  earChain?: EarChain;
  threadId?: () => string | undefined;
  /** Overrides the gate's quiet period (how long it stays open after speech ends). */
  quietPeriodMs?: number;
  /**
   * Path to the shared settings.json. When present, the realtime model and
   * voice settings route is mounted on the orb app — even when the orb itself
   * is refused, because the settings are machine facts, not session state.
   */
  settingsPath?: string;
  /**
   * Told how many faces are watching, every time the number changes.
   *
   * This is the capture-lifecycle seam: a face arriving is what starts local
   * microphone capture, and the last face leaving is what stops it. The gate
   * itself is not opened here — that is the wake word's job. The caller wires
   * the microphone; this lane only counts.
   */
  onFaceCount?: (count: number) => void;
};

export type OrbMount = {
  app: Hono;
  /** Why the orb is off, when it is. Surfaced by health the way voice's is. */
  reason?: string;
  orb?: Orb;
  /**
   * Watch the orb's event stream. Present only when the orb is live.
   *
   * Each subscription counts as a face for `onFaceCount` — the capture-lifecycle
   * seam that opens and closes the microphone — so the face source proxies each
   * face's subscribe through this rather than holding a permanent listener,
   * which would keep the machine listening after the last face left.
   */
  subscribe?(listener: (event: OrbEvent) => void): () => void;
};

const NO_PROVIDER =
  "The orb has no realtime voice provider on this machine yet. Typing still works.";
const NO_EAR =
  "The orb has no local ear on this machine yet, and it will not listen without one. Typing still works.";

/**
 * Build the orb lane, or explain why there isn't one.
 *
 * The refusals are ordered cheapest-question-first: a missing credential is the
 * thing a person can actually fix, so it is the one they are told about.
 */
export async function mountOrb(options: OrbMountOptions): Promise<OrbMount> {
  // The settings route is mounted unconditionally — it works even when the orb
  // is refused, because the settings are machine facts, not session state.
  const composeSettings = (app: Hono): Hono => {
    if (options.settingsPath) app.route("/", buildRealtimeSettingsApp(options.settingsPath));
    return app;
  };

  const credential = await resolveOrbCredential(options.credentials);
  if (isRefusal(credential)) {
    return { app: composeSettings(buildOrbApp({ reason: credential.reason })), reason: credential.reason };
  }
  if (!options.provider) {
    return { app: composeSettings(buildOrbApp({ reason: NO_PROVIDER })), reason: NO_PROVIDER };
  }
  if (!options.earChain) {
    return { app: composeSettings(buildOrbApp({ reason: NO_EAR })), reason: NO_EAR };
  }

  const listeners = new Set<(event: OrbEvent) => void>();

  // The realtime model and voice are read once at boot. The setup frame is
  // built from the resulting config, and redial reuses it — so a change a
  // person makes in the settings UI takes effect on the next conversation,
  // not mid-socket. This is the reading the issue's UI copy asks for.
  const settings = options.settingsPath
    ? await readRealtimeSettings(options.settingsPath)
    : {};

  // The orb needs a session to be constructed, and the session needs callbacks
  // that land on the orb — a genuine cycle. It is broken with an explicit box
  // rather than by reading a `const` that is not initialised yet: an event
  // arriving during `connect` would hit the temporal dead zone and throw, and
  // "the provider probably will not do that" is not a guarantee worth taking.
  // Before the orb exists, an early event is dropped, which is the correct
  // reading of a frame that arrived before anything could be listening.
  let attached: Orb | undefined;
  let session;
  try {
    session = await options.provider.connect(
      realtimeConfig({
        apiKey: credential.key,
        ...(settings.realtimeModel !== undefined ? { model: settings.realtimeModel } : {}),
        ...(settings.realtimeVoice !== undefined ? { voice: settings.realtimeVoice } : {}),
        events: {
          onAudio: (chunk) => attached?.realtimeEvents.onAudio(chunk),
          onTranscript: (text, speaker) => attached?.realtimeEvents.onTranscript(text, speaker),
          onFunctionCall: (call) => attached?.realtimeEvents.onFunctionCall(call),
          onBargeIn: () => attached?.realtimeEvents.onBargeIn(),
          onReconnect: () => attached?.realtimeEvents.onReconnect(),
          onRefusal: (reason) => attached?.realtimeEvents.onRefusal(reason),
        },
      }),
    );
  } catch (error) {
    // A provider that will not connect is an orb that is off with a reason,
    // not a hub that failed to boot: the typed chat owes nothing to Google.
    const reason = `The realtime voice provider refused to connect: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return { app: composeSettings(buildOrbApp({ reason })), reason };
  }

  const orb = new Orb({
    gate: {
      ...options.earChain,
      ...(options.quietPeriodMs !== undefined ? { quietPeriodMs: options.quietPeriodMs } : {}),
    },
    session,
    bank: new UtteranceBank(options.clips),
    mouth: new Mouth(),
    speaker: options.speaker,
    brain: createHubBrain({
      turn: options.turn,
      ...(options.threadId ? { threadId: options.threadId } : {}),
    }),
    onEvent: (event) => {
      for (const listener of listeners) listener(event);
    },
  });
  attached = orb;

  const subscribe = (listener: (event: OrbEvent) => void) => {
    listeners.add(listener);
    options.onFaceCount?.(listeners.size);
    return () => {
      if (listeners.delete(listener)) options.onFaceCount?.(listeners.size);
    };
  };

  return {
    app: composeSettings(buildOrbApp({ orb, subscribe })),
    orb,
    subscribe,
  };
}
