import path from "node:path";

import { serve } from "@hono/node-server";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { Mastra } from "@mastra/core/mastra";

import { buildApp } from "./app.ts";
import { buildAuditApp } from "./audit/routes.ts";
import { createProviderAuth } from "./auth/index.ts";
import { buildAutostartApp } from "./autostart/routes.ts";
import { cureChromiumApps, type CureReport } from "./curing/curing.ts";
import { resolveClientConfig } from "./config.ts";
import { buildDevicesApp } from "./devices/index.ts";
import { buildDesktopConfigApp } from "./desktop-config/routes.ts";
import {
  DEVICE_CREDENTIALS_FILE,
  attachEventSocket,
  combineEventSources,
  createDeviceCredentialStore,
  createTouchLane,
} from "./events/index.ts";
import { prepareHub } from "./hub.ts";
import { resolveModelPack } from "./model-pack.ts";
import { buildModelPacksApp } from "./model-packs/routes.ts";
import { ModelPacksService } from "./model-packs/service.ts";
import { FilePackStore } from "./model-packs/store.ts";
import { buildPairingApp, createTicketMint } from "./pairing/index.ts";
import { auditFile, configFile } from "./paths.ts";
import { wrapTurnWithPermissionAwareness } from "./permissions/aware-turn.ts";
import { findDaemonSocket, readCensus } from "./permissions/daemon.ts";
import { createPermissionRegistry } from "./permissions/registry.ts";
import { buildPermissionsApp } from "./permissions/routes.ts";
import { createHubBrain, createLaneFaceSource, mountOrb } from "./orb/index.ts";
import { applicationDirs, scanDesktopEntries } from "./platform/freedesktop/entries.ts";
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

/**
 * The packs, and the one a person picked.
 *
 * Built before the hub because the hub asks it which pack to think with on
 * every turn. The read is deliberately wrapped: a pack file somebody hand-edited
 * into unreadable shape must not take the chat down with it, so the turn falls
 * back to the pack this build declares — the same pack a machine with no file at
 * all runs. Nothing is hidden by that fallback: the Models page's own route
 * refuses with the parser's reason, which is where a person can act on it.
 */
const modelPacks = new ModelPacksService({
  store: new FilePackStore(hubDir),
  credentials: providerAuth.credentials,
});
const activePack = () => {
  try {
    return modelPacks.activePack();
  } catch {
    return resolveModelPack();
  }
};

const hub = await prepareHub(config, { settings, observe: touchLane.observe, activePack });

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
const permissionRegistry = createPermissionRegistry({
  configPath: configFile(config.platform.paths),
  readCensus: () => readCensus(findDaemonSocket()),
  scanInstalled: config.platform.scanInstalled,
});
const chat = wrapTurnWithPermissionAwareness(hub.chat, permissionRegistry);

/**
 * Curing, run at boot and on demand from the permissions page.
 *
 * At boot because a permission granted yesterday should be readable this
 * morning without anyone clicking anything, and on demand because permitting
 * an application is exactly the moment its launcher wants the flag. Both call
 * the same function, and it only ever rewrites launchers under the user's own
 * ~/.local/share/applications.
 *
 * Built only where the platform says the trick exists. The `.desktop` override
 * has no equivalent on the other two families, so on those the function is
 * never made and the route answers 501 instead of pretending. That flag is also
 * why this is the one place the hub reads a freedesktop entry directly: curing
 * needs the file a launcher was read from, which is a fact about this platform's
 * launchers and has no neutral spelling in the port.
 */
const cureNow: (() => Promise<CureReport>) | undefined = config.platform.supports.shortcutCuring
  ? async (): Promise<CureReport> =>
      cureChromiumApps({
        rows: (await permissionRegistry.view()).applications,
        // The directory overrides are written to comes first, so a second run
        // reads the cured file rather than the system copy it shadows — which
        // is what makes curing idempotent instead of eternally rewriting.
        entries: await scanDesktopEntries([config.applicationsDir, ...applicationDirs()]),
        userApplicationsDir: config.applicationsDir,
      })
  : undefined;


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
 * What the hub knows about voice, all of it derived from the lane.
 *
 * There is no microphone, no speaker, and no realtime session in this process
 * any more — the devices own those, and the lane below tells this source what
 * they are doing. Built before the orb mounts because the status route reads
 * its mouth count, and before the socket attaches because the socket feeds it.
 */
const faces = createLaneFaceSource();

/**
 * The orb's hub side: the token mint, the realtime settings, the status route,
 * and the SSE face — deaf by design. It comes up refused only when there is
 * no Google credential, and the reason travels to the page through
 * /api/health and /api/orb/status, exactly as the voice lane's does.
 */
const orb = await mountOrb({
  credentials: storage,
  settingsPath: path.join(config.root, config.configDir, "settings.json"),
  faces: { mouths: faces.mouths, subscribe: faces.subscribeFace },
});

/**
 * One store, two consumers: the `/events` door that checks credentials and the
 * pairing routes that mint and revoke them. Built here rather than inside
 * either, because two stores over one file would be two answers to "is this
 * device paired" — and the door's answer is the one that matters.
 */
const deviceCredentials = createDeviceCredentialStore(
  path.join(hubDir, DEVICE_CREDENTIALS_FILE),
);

/**
 * The device list reads the live socket rather than a snapshot.
 *
 * The socket cannot exist yet — it attaches to a server that has not been
 * created — so the count is asked for through a closure instead of passed in.
 * By the time any request reaches this route the module has finished
 * evaluating, and the answer is whatever is attached at that moment, which is
 * the only answer worth giving about who is connected.
 */
const devices = buildDevicesApp({
  faces: () => eventSocket.faceCount,
  paired: () => deviceCredentials.list(),
});

const pairing = buildPairingApp({
  tickets: createTicketMint(),
  credentials: deviceCredentials,
});

const app = buildApp({
  chat,
  uiRoot: config.uiRoot,
  dashboardRoot: config.dashboardRoot,
  status: hub.status,
  auth: providerAuth.app,
  voice,
  orb,
  permissions: buildPermissionsApp(permissionRegistry, config.platform.icons, cureNow),
  audit: buildAuditApp(auditFile(config.platform.paths)),
  devices,
  pairing,
  /**
   * The platform's own config directory, so it edits the file the daemon
   * actually reads. The hub runs as the user and rewrites the user's own file;
   * nothing here reaches the daemon socket, which remains unable to author its
   * own ceiling.
   */
  desktopConfig: buildDesktopConfigApp({ file: configFile(config.platform.paths) }),
  /**
   * Writes the person's own XDG autostart entry through the platform port —
   * the session manager launches the widget at login, the hub only holds the
   * pen.
   */
  autostart: buildAutostartApp({ platform: config.platform }),
  modelPacks: buildModelPacksApp(modelPacks),
});

// Cure at boot, once, and never fatally: a launcher that could not be
// rewritten leaves the application unreadable, which the permissions page
// already shows plainly. It is not a reason to refuse to start the hub.
void cureNow?.()
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
 * The face pipe carries what the hub actually knows: the states derived from
 * the lane's conversation (a mouth opened somewhere, an ask is in flight, an
 * answer went out) and the touch lane's scouts. Captions are deliberately not
 * in the derived source — the socket relays them to its faces itself, and a
 * word said twice is noise.
 *
 * A face opens one connection and hears one vocabulary; whether a given word
 * came from the conversation or from the agent's hands is the hub's business,
 * not the face's.
 */
export const eventSource = combineEventSources(faces.source, touchLane);

/**
 * The lane's brain rides the same wrapped turn as the typed route's — an
 * `ask` that arrives over the socket is indistinguishable downstream from one
 * that was typed. The dispatch seam depends on the agent, never on a realtime
 * session: those live on the devices now, and this brain is what they call.
 * The observer closes the loop — the socket tells the face source what the
 * conversation is doing, and every face draws from that.
 */
export const eventSocket = attachEventSocket(server, eventSource, {
  brain: createHubBrain({ turn: chat }),
  observer: faces.observer,
  // The same store the pairing routes mint into, so a phone that finished the
  // QR ceremony is admitted by the object that granted it rather than by a
  // second reader of the same file.
  credentials: deviceCredentials,
});
