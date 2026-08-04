import { serve } from "@hono/node-server";
import { Mastra } from "@mastra/core/mastra";

import { buildApp } from "./app.ts";
import { resolveClientConfig } from "./config.ts";
import { prepareHub } from "./hub.ts";

const config = resolveClientConfig();
const hub = await prepareHub(config);

/**
 * The literal stays here, in the entry module, on purpose: the deployer's
 * `checkConfigExport` Babel plugin only marks a Mastra config valid when it
 * finds a top-level `new Mastra(...)` exported as `mastra` in this file.
 */
export const mastra = new Mastra(hub.mastraArgs);

await hub.finalize();

const app = buildApp({ chat: hub.chat, uiRoot: config.uiRoot, status: hub.status });

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
