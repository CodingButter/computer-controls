/**
 * The permissions routes.
 *
 * Two endpoints, both user-facing: a listing the page reads on load and a
 * write the page calls when a checkbox is toggled. Both forward to the daemon's
 * registry methods over the hub's own socket connection.
 *
 * The same-origin guard from the sign-in surface applies here for the same
 * reason: a page on another origin that could POST to this route could
 * silently permit an application the user has not approved, widening the
 * agent's reach without the user's knowledge.
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

import { DaemonRegistryClient } from "./daemon-client.ts";

export const PERMISSIONS_API_PATH = "/api/permissions";

/**
 * Refuse anything a different page sent here — same pattern as the auth routes.
 * See auth/routes.ts for the rationale: SameSite cookies and JSON-only writes
 * together defeat CSRF without a CORS header in sight.
 */
function requireSameOrigin(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== "null") {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).host === new URL(c.req.url).host;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) return c.json({ error: "Requests must come from this hub." }, 403);
    }

    if (c.req.method !== "GET") {
      const contentType = c.req.header("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        return c.json({ error: "Expected a JSON request." }, 415);
      }
    }

    await next();
  };
}

/** Read a JSON body, refusing anything that is not an object. */
async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return {};
    }
    return body as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface PermissionsRouteOptions {
  /** Override for tests; defaults to a real daemon client. */
  client?: DaemonRegistryClient;
}

export function createPermissionsApp(options: PermissionsRouteOptions = {}): Hono {
  const client = options.client ?? new DaemonRegistryClient();
  const routes = new Hono();

  routes.use("*", requireSameOrigin());

  routes.get("/", async (c) => {
    try {
      return c.json(await client.getApplicationPermissions());
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "The desktop daemon is unavailable." },
        502,
      );
    }
  });

  routes.post("/", async (c) => {
    const body = await readJsonBody(c);
    const application = body["application"];
    const permitted = body["permitted"];
    if (typeof application !== "string" || !application.trim()) {
      return c.json({ error: "Missing application." }, 400);
    }
    if (typeof permitted !== "boolean") {
      return c.json({ error: "Missing permitted." }, 400);
    }
    try {
      return c.json(await client.setApplicationPermission(application, permitted));
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "The desktop daemon is unavailable." },
        502,
      );
    }
  });

  const app = new Hono();
  app.route(PERMISSIONS_API_PATH, routes);
  return app;
}
