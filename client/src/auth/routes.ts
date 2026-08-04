/**
 * The sign-in routes.
 *
 * The shape is Factory's, because Factory already solved the awkward part: an
 * OAuth flow driven from a browser over stateless HTTP needs a start, a way to
 * finish (paste for one provider, poll for the other), and a way to look a flow
 * back up when the page reloads mid-login. Hence `start`, `complete`, `poll`,
 * `session/:id`, and a listing route that says which providers exist and which
 * are connected.
 *
 * On identity: local mode ships with no auth adapter — one process, one person,
 * no login gate — which leaves the question of what "the owner of this flow"
 * means. It means the browser that started it. The first request through here
 * is issued an opaque owner id in an HttpOnly cookie, and that id is what the
 * session store checks. It is not an authentication claim and does not pretend
 * to be one; it is the difference between "the tab that started this login" and
 * "anything else that can reach this port", which is exactly the distinction
 * ownership needs to make. When tenant mode brings a real user id, it replaces
 * the one line that reads this cookie.
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";

import { parseProviderId } from "./providers.ts";
import { LoginRequestError, type ProviderLoginService } from "./service.ts";

export const PROVIDER_AUTH_BASE_PATH = "/api/oauth";

/** The browser-scoped owner id. HttpOnly: the page never needs to read it. */
export const OWNER_COOKIE = "cc_login_owner";

type OwnerEnv = { Variables: { ownerId: string } };

export interface ProviderAuthRouteOptions {
  service: ProviderLoginService;
  /**
   * Whether to mark the owner cookie `Secure`. Off by default because the local
   * hub serves plain HTTP on localhost, where a Secure cookie is simply dropped.
   */
  secureCookie?: boolean;
}

/**
 * Give the caller an owner id, minting one if this is their first request.
 */
export function ownerIdentity(options: { secureCookie?: boolean } = {}): MiddlewareHandler<OwnerEnv> {
  return async (c, next) => {
    const existing = getCookie(c, OWNER_COOKIE);
    const ownerId = existing ?? randomUUID();
    if (!existing) {
      setCookie(c, OWNER_COOKIE, ownerId, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
        secure: options.secureCookie ?? false,
      });
    }
    c.set("ownerId", ownerId);
    await next();
  };
}

/**
 * Refuse anything a different page sent here.
 *
 * The hub answers on localhost, which any page in the browser can reach. Most
 * of this surface is protected by the owner cookie, but two routes are not and
 * cannot be: `disconnect` and `api-key` name a provider rather than a flow. A
 * page on another origin that could POST to them could sign a person out of
 * their model account, or — much worse — plant its own API key and have every
 * subsequent agent request billed to, and visible to, whoever planted it.
 *
 * Two checks close that, and they need each other. `SameSite=Strict` keeps the
 * owner cookie off a cross-site request but does nothing to stop the request
 * itself. Requiring `application/json` on every write means a cross-origin
 * caller must send a preflight, and we answer no CORS headers, so the browser
 * refuses before the request is made — without it, a `text/plain` body is a
 * "simple request" that skips preflight entirely and lands. The Origin check
 * then catches the callers that do announce themselves.
 */
function requireSameOrigin(): MiddlewareHandler<OwnerEnv> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== "null") {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).host === new URL(c.req.url).host;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) throw new LoginRequestError(403, "Requests must come from this hub.");
    }

    if (c.req.method !== "GET") {
      const contentType = c.req.header("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        throw new LoginRequestError(415, "Expected a JSON request.");
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
      throw new LoginRequestError(400, "Expected a JSON object.");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof LoginRequestError) throw error;
    throw new LoginRequestError(400, "Expected a JSON object.");
  }
}

function requireProvider(body: Record<string, unknown>) {
  const provider = parseProviderId(body["provider"]);
  if (!provider) throw new LoginRequestError(400, "Unknown provider.");
  return provider;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw new LoginRequestError(400, `Missing ${field}.`);
  return value;
}

/**
 * The routes themselves, mounted under {@link PROVIDER_AUTH_BASE_PATH}.
 *
 * Returned as a Hono app rather than a running server: the client's own server
 * mounts it, and a test can drive it over real HTTP semantics without opening a
 * port.
 */
export function createProviderAuthApp(options: ProviderAuthRouteOptions): Hono {
  const { service } = options;
  const routes = new Hono<OwnerEnv>();

  routes.use("*", requireSameOrigin());
  routes.use("*", ownerIdentity({ secureCookie: options.secureCookie }));

  routes.get("/flows", (c) => c.json({ providers: service.listFlows() }));

  routes.post("/start", async (c) => {
    const body = await readJsonBody(c);
    return c.json(await service.startLogin(c.get("ownerId"), requireProvider(body)));
  });

  routes.post("/complete", async (c) => {
    const body = await readJsonBody(c);
    const view = await service.completeLogin(
      c.get("ownerId"),
      requireString(body, "sessionId"),
      requireString(body, "code"),
    );
    return c.json(view);
  });

  routes.post("/poll", async (c) => {
    const body = await readJsonBody(c);
    const view = await service.pollLogin(c.get("ownerId"), requireString(body, "sessionId"));
    return c.json(view);
  });

  routes.get("/session/:id", (c) => c.json(service.getSession(c.get("ownerId"), c.req.param("id"))));

  routes.post("/api-key", async (c) => {
    const body = await readJsonBody(c);
    const provider = requireProvider(body);
    return c.json(service.saveApiKey(provider, requireString(body, "key")));
  });

  routes.post("/disconnect", async (c) => {
    const body = await readJsonBody(c);
    return c.json(service.disconnect(requireProvider(body)));
  });

  routes.onError((error, c) => {
    if (error instanceof LoginRequestError) {
      return c.json({ error: error.message }, error.status as 400 | 403 | 404 | 415);
    }
    // A provider outage is not the caller's mistake, and its stack is not the
    // caller's business.
    return c.json({ error: "Sign-in is temporarily unavailable." }, 502);
  });

  const app = new Hono();
  app.route(PROVIDER_AUTH_BASE_PATH, routes);
  return app;
}
