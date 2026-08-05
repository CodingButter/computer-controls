import { Hono } from "hono";

import { MalformedConfigError, type PermissionRegistry } from "./registry.ts";

/**
 * The permissions page's HTTP surface: read the merged view, toggle one app.
 *
 * Two routes, and neither can widen anything the daemon holds. The PUT writes
 * the user's own config file — the same file they could open in an editor —
 * and the daemon's ceiling re-reads it on its own; nothing here speaks to the
 * daemon socket except to ask, read-only, what is running. A hub route that
 * could widen the ceiling directly would be the capability leak the whole
 * consent design exists to prevent, so the route that changes things only
 * knows how to edit a file the user already owns.
 */
export function buildPermissionsApp(registry: PermissionRegistry): Hono {
  const app = new Hono();

  app.get("/api/permissions", async (c) => {
    try {
      return c.json(await registry.view());
    } catch (error) {
      if (error instanceof MalformedConfigError) {
        // The user's hand-written config is broken. Refused with the reason,
        // never silently overwritten and never dressed up as an empty list.
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  app.put("/api/permissions/:app", async (c) => {
    const appName = c.req.param("app");
    const body = await c.req.json().catch(() => undefined);
    const permitted = (body as { permitted?: unknown } | undefined)?.permitted;
    if (typeof permitted !== "boolean") {
      return c.json({ error: "permitted must be a boolean" }, 400);
    }

    try {
      return c.json(await registry.setPermitted(appName, permitted));
    } catch (error) {
      if (error instanceof MalformedConfigError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  return app;
}
