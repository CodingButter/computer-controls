/**
 * Signing in with your own model accounts, assembled.
 *
 * Three things get wired together here and nowhere else: the SDK's own login
 * flows, the SDK's own `auth.json` credential store, and a session store that
 * holds the flow state in between. Everything above this line is composition;
 * the parts underneath are the SDK's, which is the point — we are not
 * reimplementing OAuth, we are giving a browser a way to drive the flows Mastra
 * Code already ships.
 */

import { Hono } from "hono";
import { registerApiRoute } from "@mastra/core/server";
import type { ApiRoute } from "@mastra/core/server";

import {
  AuthStorageCredentialStore,
  type CredentialBackingStore,
  type CredentialStore,
} from "./credentials.ts";
import { sdkLoginFlows, type ProviderLoginFlows } from "./flows.ts";
import type { ApiKeyVerifier } from "./key-verification.ts";
import { InMemoryLoginSessionStore, type LoginSessionStore } from "./login-sessions.ts";
import { PROVIDER_AUTH_BASE_PATH, createProviderAuthApp } from "./routes.ts";
import { renderSettingsPage } from "./settings-page.ts";
import { ProviderLoginService } from "./service.ts";

export { PROVIDER_AUTH_BASE_PATH, OWNER_COOKIE, createProviderAuthApp } from "./routes.ts";
export { AuthStorageCredentialStore } from "./credentials.ts";
export { InMemoryLoginSessionStore, DEFAULT_LOGIN_SESSION_TTL_MS } from "./login-sessions.ts";
export { ProviderLoginService, LoginRequestError, toSessionView } from "./service.ts";
export { sdkLoginFlows } from "./flows.ts";
export {
  PROVIDERS,
  PROVIDER_IDS,
  describeProvider,
  getAuthProviderId,
  parseProviderId,
} from "./providers.ts";
export { createApiKeyVerifier } from "./key-verification.ts";
export { renderSettingsPage } from "./settings-page.ts";

export type { CredentialStore, CredentialBackingStore, ProviderConnection } from "./credentials.ts";
export type { ProviderLoginFlows, AnthropicLoginStart, DevicePollResult } from "./flows.ts";
export type {
  LoginSession,
  LoginSessionStore,
  LoginSessionStatus,
  DeviceLoginPending,
} from "./login-sessions.ts";
export type { LoginSessionView, ProviderFlowView } from "./service.ts";
export type { ProviderDescriptor, ProviderId, LoginKind } from "./providers.ts";
export type { ApiKeyVerifier, KeyVerification } from "./key-verification.ts";

/** Where the settings section is served. */
export const PROVIDER_AUTH_SETTINGS_PATH = "/settings/accounts";

export interface ProviderAuthOptions {
  /** The `auth.json` store. `new AuthStorage()` in local mode. */
  storage: CredentialBackingStore;
  /** Override for tests; defaults to the SDK's real flows. */
  flows?: ProviderLoginFlows;
  /** Override for tests; defaults to asking the provider over the network. */
  verifier?: ApiKeyVerifier;
  /** Override for tenant mode; defaults to an in-process store. */
  sessions?: LoginSessionStore;
  /** Set when the hub is served over TLS. */
  secureCookie?: boolean;
}

export interface ProviderAuth {
  service: ProviderLoginService;
  credentials: CredentialStore;
  sessions: LoginSessionStore;
  /** The API routes plus the settings section, ready to mount. */
  app: Hono;
}

export function createProviderAuth(options: ProviderAuthOptions): ProviderAuth {
  const credentials = new AuthStorageCredentialStore(options.storage);
  const sessions = options.sessions ?? new InMemoryLoginSessionStore();
  const service = new ProviderLoginService({
    sessions,
    credentials,
    flows: options.flows ?? sdkLoginFlows,
    ...(options.verifier !== undefined ? { verifier: options.verifier } : {}),
  });

  const app = new Hono();
  app.route("/", createProviderAuthApp({ service, secureCookie: options.secureCookie }));
  app.get(PROVIDER_AUTH_SETTINGS_PATH, (c) => c.html(renderSettingsPage()));

  return { service, credentials, sessions, app };
}

/**
 * The same routes as Mastra `ApiRoute` descriptors, for a client that assembles
 * its server the way Factory does.
 *
 * Each one hands the raw request to the Hono app above rather than
 * reimplementing the handler, so there is one copy of the logic and the tests
 * that drive the app are testing what the server serves.
 *
 * Deliberately not marked `requiresAuth: false`. Local mode has no auth adapter
 * to satisfy, so the default costs nothing today — and if a client ever gains
 * one, the routes that hand out credentials should be behind it rather than
 * carrying an old exemption nobody remembers granting.
 */
export function providerAuthApiRoutes(auth: ProviderAuth): ApiRoute[] {
  const forward = (c: { req: { raw: Request } }) => auth.app.fetch(c.req.raw);
  const base = PROVIDER_AUTH_BASE_PATH;

  return [
    registerApiRoute(`${base}/flows`, { method: "GET", handler: forward }),
    registerApiRoute(`${base}/start`, { method: "POST", handler: forward }),
    registerApiRoute(`${base}/complete`, { method: "POST", handler: forward }),
    registerApiRoute(`${base}/poll`, { method: "POST", handler: forward }),
    registerApiRoute(`${base}/session/:id`, { method: "GET", handler: forward }),
    registerApiRoute(`${base}/api-key`, { method: "POST", handler: forward }),
    registerApiRoute(`${base}/disconnect`, { method: "POST", handler: forward }),
    registerApiRoute(PROVIDER_AUTH_SETTINGS_PATH, { method: "GET", handler: forward }),
  ];
}
