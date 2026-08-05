import os from "node:os";

import { serve } from "@hono/node-server";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { Mastra } from "@mastra/core/mastra";

import { buildApp } from "./app.ts";
import { createProviderAuth } from "./auth/index.ts";
import { resolveClientConfig } from "./config.ts";
import { attachEventSocket } from "./events/index.ts";
import { prepareHub } from "./hub.ts";
import { wrapTurnWithPermissionAwareness } from "./permissions/aware-turn.ts";
import { defaultConfigPath } from "./permissions/config-file.ts";
import { findDaemonSocket, readCensus } from "./permissions/daemon.ts";
import {
  SYSTEM_APPLICATIONS_DIR,
  scanDesktopEntries,
  userApplicationsDir,
} from "./permissions/desktop-entries.ts";
import { createIconSource, defaultIconDirs } from "./permissions/icons.ts";
import { createPermissionRegistry } from "./permissions/registry.ts";
import { buildPermissionsApp } from "./permissions/routes.ts";
import { commandSpeaker, startMicrophone, type Microphone } from "./orb/audio-host.ts";
import { pocEarChain } from "./orb/ear-poc.ts";
import { diskClipStore, unwiredSpeaker } from "./orb/host.ts";
import { chooseFaceSource, mountOrb } from "./orb/index.ts";
import { geminiLiveProvider } from "./orb/live-gemini.ts";
import {
  createSessionVoice,
  isRefusal,
  listVoiceProviders,
  resolveVoiceProvider,
} from "./voice/index.ts";
import { buildVoiceApp } from "./voice/routes.ts";

const config = resolveClientConfig();
const hub = await prepareHub(config);

/**
 * The permission registry, and the one wrapping of the hub's turn.
 *
 * Wrapped here, right after the hub hands its turn back, because this is the
 * single site both transports flow from: the orb's `turn:` below and the
 * typed route's `chat:` receive the same wrapped function, so a request that
 * arrived by voice and one that arrived by typing get the same "no permission
 * yet" context. brain, app and hub stay untouched — the signal is a wrapper,
 * not a rewrite.
 */
const scanInstalled = () =>
  scanDesktopEntries([SYSTEM_APPLICATIONS_DIR, userApplicationsDir(os.homedir())]);
const permissionRegistry = createPermissionRegistry({
  configPath: defaultConfigPath(),
  readCensus: () => readCensus(findDaemonSocket()),
  scanInstalled,
});
const appIconSource = createIconSource(scanInstalled, defaultIconDirs(os.homedir()));
const chat = wrapTurnWithPermissionAwareness(hub.chat, permissionRegistry);

/**
 * The literal stays here, in the entry module, on purpose: the deployer's
 * `checkConfigExport` Babel plugin only marks a Mastra config valid when it
 * finds a top-level `new Mastra(...)` exported as `mastra` in this file.
 */
export const mastra = new Mastra(hub.mastraArgs);

await hub.finalize();

/**
 * Sign-in writes to the same file-backed `auth.json` the TUI reads, so a login
 * through the browser is a login everywhere on this machine.
 */
const storage = new AuthStorage();
const providerAuth = createProviderAuth({ storage });

/**
 * The ear and the mouth resolve from the same store the sign-in surface
 * writes, at boot: connect a voice account and the next start has a voice.
 * No credential, no voice; the reason travels to the UI through /api/health.
 *
 * Which account, when more than one is connected, is the person's setting —
 * `config.voiceProvider`. The list of mouths they could pick from is read per
 * request instead, because connecting one must not require a restart to show up
 * in the settings section.
 */
const voiceCredential = await resolveVoiceProvider(storage, config.voiceProvider);
const voice = {
  app: buildVoiceApp({
    voice: createSessionVoice(voiceCredential),
    providers: () => listVoiceProviders(storage),
    ...(isRefusal(voiceCredential) ? { reason: voiceCredential.reason } : {}),
  }),
  ...(isRefusal(voiceCredential) ? { reason: voiceCredential.reason } : {}),
};

/**
 * The orb, mounted from the same store and the same agent.
 *
 * It comes up refused on a machine that has no realtime provider or no OS audio
 * capture wired — both are seams awaiting the work in #107 — and the reason
 * travels to the page through /api/health and /api/orb/status, exactly as the
 * voice lane's does. The page then explains itself instead of offering a control
 * that cannot work, and the typed chat is unaffected either way.
 */
/**
 * The live lane is opt-in scaffolding: COMCON_ORB_LIVE wires the real Gemini
 * socket, the machine's microphone and speaker, and the visit-is-consent gate.
 * Off — the default, and what every test boots — the orb mounts exactly as
 * before: refused with a reason, no socket opened, no process spawned. The
 * flag comes off when #107's widget work makes the capture path permanent.
 */
const orbLive = process.env.COMCON_ORB_LIVE === "1";
let orbFaceCount: ((count: number) => void) | undefined;

const orb = await mountOrb({
  credentials: storage,
  turn: chat,
  clips: diskClipStore(config.root),
  ...(orbLive
    ? {
        speaker: commandSpeaker(),
        provider: geminiLiveProvider(),
        earChain: pocEarChain(),
        // Visiting the page is the consent; the gate holds for the sitting.
        quietPeriodMs: 24 * 60 * 60 * 1000,
        onFaceCount: (count: number) => orbFaceCount?.(count),
      }
    : { speaker: unwiredSpeaker }),
});

if (orbLive && orb.orb) {
  const livingOrb = orb.orb;
  let microphone: Microphone | undefined;
  orbFaceCount = (count) => {
    if (count > 0 && !microphone) {
      // A face arrived: the deliberate act. The mic opens and the gate with it.
      microphone = startMicrophone({ onFrame: (frame) => void livingOrb.push(frame) });
      if (livingOrb.gateState !== "open") livingOrb.toggle();
      return;
    }
    if (count === 0 && microphone) {
      // The last face left: the machine goes quiet, process and gate both.
      livingOrb.closeGate();
      microphone.stop();
      microphone = undefined;
    }
  };
}

const app = buildApp({
  chat,
  uiRoot: config.uiRoot,
  dashboardRoot: config.dashboardRoot,
  status: hub.status,
  auth: providerAuth.app,
  voice,
  orb,
  permissions: buildPermissionsApp(permissionRegistry, appIconSource),
});

let announce: (url: string) => void;
/** Resolves once the port is actually bound — a test can wait on it, a human can read it. */
export const listening = new Promise<string>((resolve) => {
  announce = resolve;
});

export const server = serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  (info) => {
    const url = `http://${config.host}:${info.port}`;
    console.log(`[client] ${url} — desktop scope "${config.desktopScope}"`);
    announce(url);
  },
);

/**
 * The hub's state, offered to whatever is drawing it.
 *
 * When the orb is live, the face pipe hears it: the adapter translates the orb's
 * events into the face vocabulary and routes mute and dismiss to its gate. When
 * the orb is refused — no provider, no ear, no credential — the scripted source
 * stays, and a face sees idle, which is the truth.
 */
export const eventSource = chooseFaceSource(orb);
export const eventSocket = attachEventSocket(server, eventSource);
