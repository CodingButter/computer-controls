/**
 * Application permissions, assembled.
 *
 * Mirrors the auth module's shape: a Hono app that mounts the API routes and
 * serves the settings section as a GET, ready for the client's own server to
 * mount before the SPA fallback.
 *
 * The permissions page is user-facing only. The agent never sees the registry
 * list through a tool — ruling 1 says no agent-facing API can widen a
 * permission, and this page is the only write path.
 */

import { Hono } from "hono";

import { PERMISSIONS_API_PATH, createPermissionsApp, type PermissionsRouteOptions } from "./routes.ts";
import { renderPermissionsPage } from "./permissions-page.ts";

export { PERMISSIONS_API_PATH, createPermissionsApp } from "./routes.ts";
export { renderPermissionsPage } from "./permissions-page.ts";
export { DaemonRegistryClient, daemonSocketPath } from "./daemon-client.ts";

/** Where the permissions page is served. */
export const PERMISSIONS_PAGE_PATH = "/settings/permissions";

export type PermissionsOptions = PermissionsRouteOptions;

export interface PermissionsModule {
  /** The API routes plus the permissions page, ready to mount. */
  app: Hono;
}

export function createPermissions(options: PermissionsOptions = {}): PermissionsModule {
  const app = new Hono();
  app.route("/", createPermissionsApp(options));
  app.get(PERMISSIONS_PAGE_PATH, (c) => c.html(renderPermissionsPage()));
  return { app };
}
