import { Hono } from "hono";

import type { CureReport } from "../curing/curing.ts";
import type { IconSource } from "../platform/index.ts";
import { MalformedConfigError, type PermissionRegistry } from "./registry.ts";

/**
 * The permissions page's HTTP surface: read the merged view, set how far into
 * one application an agent may go.
 *
 * Two routes, and neither can widen anything the daemon holds. The PUT writes
 * the user's own config file — the same file they could open in an editor —
 * and the daemon's ceiling re-reads it on its own; nothing here speaks to the
 * daemon socket except to ask, read-only, what is running. A hub route that
 * could widen the ceiling directly would be the capability leak the whole
 * consent design exists to prevent, so the route that changes things only
 * knows how to edit a file the user already owns.
 */
export function buildPermissionsApp(
  registry: PermissionRegistry,
  iconFor?: IconSource,
  cure?: () => Promise<CureReport>,
): Hono {
  const app = new Hono();

  // Curing edits launchers the user owns so a permitted Chromium application
  // builds its accessibility tree at its next start. It is a POST because it
  // writes, and it answers with what it did — including which applications the
  // person still has to restart, because the hub never closes their windows.
  app.post("/api/permissions/cure", async (c) => {
    if (!cure) return c.json({ error: "Curing is not available on this machine." }, 501);
    try {
      return c.json(await cure());
    } catch (error) {
      if (error instanceof MalformedConfigError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  // The page's row icons, resolved by the platform adapter from whatever this
  // machine keeps icons in. The parameter is the adapter's own id for an
  // application, handed straight back to it — this route never turns it into a
  // filesystem path. A missing icon is a 404 the page answers with an
  // initial-letter avatar, not an error.
  app.get("/api/permissions/icon/:desktopId", async (c) => {
    const icon = await iconFor?.(c.req.param("desktopId"));
    if (!icon) return c.text("no icon", 404);
    c.header("content-type", icon.mediaType);
    c.header("cache-control", "max-age=3600");
    return c.body(new Uint8Array(icon.bytes));
  });

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
    const access = (body as { access?: unknown } | undefined)?.access;
    // `custom` is a shape the file can hold and this route cannot be asked
    // for: it describes a hand-written entry, and the only way to reach one is
    // to write it by hand. Accepting it here would mean inventing which
    // classes the caller meant.
    if (access !== "off" && access !== "view" && access !== "interact") {
      return c.json({ error: 'access must be one of "off", "view", "interact"' }, 400);
    }

    try {
      return c.json(await registry.setAccess(appName, access));
    } catch (error) {
      if (error instanceof MalformedConfigError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  return app;
}
