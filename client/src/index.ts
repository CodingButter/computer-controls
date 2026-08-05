import os from "node:os";
import path from "node:path";

import { serve } from "@hono/node-server";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { Mastra } from "@mastra/core/mastra";

import { buildApp } from "./app.ts";
import { defaultAuditPath } from "./audit/log.ts";
import { buildAuditApp } from "./audit/routes.ts";
import { createProviderAuth } from "./auth/index.ts";
import { cureChromiumApps, type CureReport } from "./curing/curing.ts";
import { resolveClientConfig } from "./config.ts";
import { buildDevicesApp } from "./devices/index.ts";
import { buildDesktopConfigApp } from "./desktop-config/routes.ts";
import { attachEventSocket, combineEventSources, createTouchLane } from "./events/index.ts";
import { prepareHub } from "./hub.ts";
import { wrapTurnWithPermissionAwareness } from "./permissions/aware-turn.ts";
import { defaultConfigPath } from "./permissions/config-file.ts";
import { findDaemonSocket, readCensus } from "./permissions/daemon.ts";
import { SYSTEM_APPLICATIONS_DIR, scanDesktopEntries } from "./permissions/desktop-entries.ts";
import { createIconSource, defaultIconDirs } from "./permissions/icons.ts";
import { createPermissionRegistry } from "./permissions/registry.ts";
import { buildPermissionsApp } from "./permissions/routes.ts";
import { commandSpeaker, startMicrophone } from "./orb/audio-host.ts";
import { createCaptureLifecycle } from "./orb/capture-lifecycle.ts";
import { pocEarChain } from "./orb/ear-poc.ts";
import { diskClipStore, unwiredSpeaker } from "./orb/host.ts";
import { chooseFaceSource, createHubBrain, mountOrb } from "./orb/index.ts";
import { geminiLiveProvider } from "./orb/live-gemini.ts";
import { FileSettingsAudit } from "./settings/audit.ts";
import { SettingsGate } from "./settings/gate.ts";
import { FilePreferenceStore } from "./settings/preferences.ts";
import { SettingsService } from "./settings/service.ts";
import {
  createSessionVoice,
  isRefusal,
  listVoiceProviders,
  resolveVoiceProvider,
} from "./voice/index.ts";
import { buildVoiceApp } from "./voice/routes.ts";

const config = resolveClientConfig();

/**
 * Where the agent's hands are, watched from the moment the hub can think.
 *
 * Built before the hub because it is wired into the turn itself rather than
 * into a request: every turn, typed or spoken, reports the desktop work it does
 * through here, and a face draws a scout over each element while the operation
 * on it is in flight.
 */
const touchLane = createTouchLane();

/**
 * Sign-in writes to the same file-backed `auth.json` the TUI reads, so a login
 * through the browser is a login everywhere on this machine.
 *
 * Built before the hub, because the configuration agent the hub mounts needs
 * something to configure — and it is handed the same login service the settings
 * page's own routes use, not a second copy of it. Connecting an account by
 * asking and connecting one by clicking are the same flow, writing the same
 * file, or the two surfaces would eventually disagree about what is connected.
 */
const storage = new AuthStorage();
const providerAuth = createProviderAuth({ storage });
const hubDir = path.join(config.root, config.configDir);
const preferences = new FilePreferenceStore(hubDir);
const settings = new SettingsGate({
  audit: new FileSettingsAudit(hubDir),
  settings: new SettingsService({
    voiceCredentials: storage,
    preferences,
    login: providerAuth.service,
  }),
});

const hub = await prepareHub(config, { settings, observe: touchLane.observe });

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
  scanDesktopEntries([SYSTEM_APPLICATIONS_DIR, config.applicationsDir]);
const permissionRegistry = createPermissionRegistry({
  configPath: defaultConfigPath(),
  readCensus: () => readCensus(findDaemonSocket()),
  scanInstalled,
});
const appIconSource = createIconSource(scanInstalled, defaultIconDirs(os.homedir()));
const chat = wrapTurnWithPermissionAwareness(hub.chat, permissionRegistry);

/**
 * Curing, run at boot and on demand from the permissions page.
 *
 * At boot because a permission granted yesterday should be readable this
 * morning without anyone clicking anything, and on demand because permitting
 * an application is exactly the moment its launcher wants the flag. Both call
 * the same function, and it only ever rewrites launchers under the user's own
 * ~/.local/share/applications.
 */
const cureNow = async (): Promise<CureReport> =>
  cureChromiumApps({
    rows: (await permissionRegistry.view()).applications,
    entries: scanInstalled(),
    userApplicationsDir: config.applicationsDir,
  });


/**
 * The literal stays here, in the entry module, on purpose: the deployer's
 * `checkConfigExport` Babel plugin only marks a Mastra config valid when it
 * finds a top-level `new Mastra(...)` exported as `mastra` in this file.
 */
export const mastra = new Mastra(hub.mastraArgs);

await hub.finalize();

/**
 * The ear and the mouth resolve from the same store the sign-in surface
 * writes, at boot: connect a voice account and the next start has a voice.
 * No credential, no voice; the reason travels to the UI through /api/health.
 *
 * Which account, when more than one is connected, is the person's setting. It
 * can arrive two ways: `COMCON_VOICE_PROVIDER`, which is the deployer stating a
 * default, and the saved preference, which is a person having said so. The
 * saved one wins — it is the newer fact, and the whole point of being able to
 * change a setting by asking is that the change outlives the sentence.
 *
 * The list of mouths they could pick from is read per request instead, because
 * connecting one must not require a restart to show up in the settings section.
 */
const voiceCredential = await resolveVoiceProvider(
  storage,
  preferences.read().voiceProvider ?? config.voiceProvider,
);
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
 * socket, the machine's microphone and speaker, and the wake-word gate. A face
 * arriving starts local capture but does NOT open the gate — the wake word
 * does. Off — the default, and what every test boots — the orb mounts exactly
 * as before: refused with a reason, no socket opened, no process spawned. The
 * flag comes off when #107's widget work makes the capture path permanent.
 */
const orbLive = process.env.COMCON_ORB_LIVE === "1";
let orbFaceCount: ((count: number) => void) | undefined;

const orb = await mountOrb({
  credentials: storage,
  turn: chat,
  clips: diskClipStore(config.root),
  settingsPath: path.join(config.root, config.configDir, "settings.json"),
  ...(orbLive
    ? {
        speaker: commandSpeaker(),
        provider: geminiLiveProvider(),
        earChain: pocEarChain(),
        onFaceCount: (count: number) => orbFaceCount?.(count),
      }
    : { speaker: unwiredSpeaker }),
});

if (orbLive && orb.orb) {
  const livingOrb = orb.orb;
  // A face arriving starts local capture but does not open the gate — the
  // wake word does. The last face leaving closes the gate and stops capture.
  orbFaceCount = createCaptureLifecycle({
    startCapture: () => startMicrophone({ onFrame: (frame) => void livingOrb.push(frame) }),
    closeGate: () => livingOrb.closeGate(),
  });
}

/**
 * The device list reads the live socket rather than a snapshot.
 *
 * The socket cannot exist yet — it attaches to a server that has not been
 * created — so the count is asked for through a closure instead of passed in.
 * By the time any request reaches this route the module has finished
 * evaluating, and the answer is whatever is attached at that moment, which is
 * the only answer worth giving about who is connected.
 */
const devices = buildDevicesApp({ faces: () => eventSocket.faceCount });

const app = buildApp({
  chat,
  uiRoot: config.uiRoot,
  dashboardRoot: config.dashboardRoot,
  status: hub.status,
  auth: providerAuth.app,
  voice,
  orb,
  permissions: buildPermissionsApp(permissionRegistry, appIconSource, cureNow),
  audit: buildAuditApp(defaultAuditPath()),
  devices,
  /**
   * No path is passed, so it edits the file the daemon actually reads. The hub
   * runs as the user and rewrites the user's own file; nothing here reaches the
   * daemon socket, which remains unable to author its own ceiling.
   */
  desktopConfig: buildDesktopConfigApp(),
});

// Cure at boot, once, and never fatally: a launcher that could not be
// rewritten leaves the application unreadable, which the permissions page
// already shows plainly. It is not a reason to refuse to start the hub.
void cureNow()
  .then((report) => {
    if (report.cured.length > 0) {
      console.log(
        `[client] cured ${report.cured.length} launcher(s): ${report.cured
          .map((entry) => entry.name)
          .join(", ")}`,
      );
    }
    if (report.needsRestart.length > 0) {
      console.log(`[client] restart to become readable: ${report.needsRestart.join(", ")}`);
    }
  })
  .catch((error: unknown) => {
    console.warn(`[client] curing skipped: ${String(error)}`);
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
 *
 * The touch lane joins it on the same socket. A face opens one connection and
 * hears one vocabulary; whether a given word came from the conversation or from
 * the agent's hands is the hub's business, not the face's.
 */
export const eventSource = combineEventSources(chooseFaceSource(orb), touchLane);

/**
 * The lane's brain rides the same wrapped turn as the orb's and the typed
 * route's — an `ask` that arrives over the socket is indistinguishable
 * downstream from one that was typed or spoken. Built here rather than
 * borrowed from the orb because the orb may be refused on this machine, and a
 * mouth on another device still deserves an answer: the dispatch seam depends
 * on the agent, never on a hub-side realtime session.
 */
export const eventSocket = attachEventSocket(server, eventSource, {
  brain: createHubBrain({ turn: chat }),
});
