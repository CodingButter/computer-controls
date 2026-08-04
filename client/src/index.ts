import { serve } from "@hono/node-server";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { Mastra } from "@mastra/core/mastra";

import { buildApp } from "./app.ts";
import { createProviderAuth } from "./auth/index.ts";
import { resolveClientConfig } from "./config.ts";
import { prepareHub } from "./hub.ts";
import {
  createSessionVoice,
  isRefusal,
  resolveVoiceCredential,
} from "./voice/index.ts";
import { buildVoiceApp } from "./voice/routes.ts";

const config = resolveClientConfig();
const hub = await prepareHub(config);

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
 * writes, at boot: connect an OpenAI account and the next start has a voice.
 * No credential, no voice; the reason travels to the UI through /api/health.
 */
const voiceCredential = await resolveVoiceCredential(storage);
const voice = {
  app: buildVoiceApp({
    voice: createSessionVoice(voiceCredential),
    ...(isRefusal(voiceCredential) ? { reason: voiceCredential.reason } : {}),
  }),
  ...(isRefusal(voiceCredential) ? { reason: voiceCredential.reason } : {}),
};

const app = buildApp({
  chat: hub.chat,
  uiRoot: config.uiRoot,
  status: hub.status,
  auth: providerAuth.app,
  voice,
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
