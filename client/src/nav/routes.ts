/**
 * The one route that serves the hub's nav links.
 *
 * Both the dashboard sidebar and the standalone pages fetch this endpoint so
 * neither carries its own copy of the list. The list itself lives in
 * `./entries.ts` — this is just the door onto it.
 */

import { Hono } from "hono";

import { NAV_ENTRIES } from "./entries.ts";

export const NAV_BASE_PATH = "/api/nav";

export function buildNavApp(): Hono {
  const app = new Hono();

  app.get(NAV_BASE_PATH, (c) => c.json({ entries: NAV_ENTRIES }));

  return app;
}
