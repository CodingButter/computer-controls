/**
 * The Models page's pack surface: read the packs, pick one, make one, delete one.
 *
 * The same shape as the permissions route and for the same reason — the write
 * edits a file the user already owns, under the hub's own root, and nothing here
 * travels the daemon socket. A pack decides which model thinks; it cannot widen
 * what that model is allowed to do, and this route holds no path to the consent
 * ceiling even by accident.
 *
 * A refusal comes back as a reason with a 409, never as a 200 over an unchanged
 * body. The page prints that reason next to the control that asked, because "no
 * key, no offer" is only honest if the person is told which key.
 */

import { Hono } from "hono";
import type { Context } from "hono";

import type { ModelPacksService, PackResult } from "./service.ts";
import { MalformedPackFile } from "./store.ts";

export const MODEL_PACKS_PATH = "/api/model-packs";

/** A malformed pack file is a refusal with the reason, not an empty list. */
function refusal(error: unknown): { message: string } | undefined {
  return error instanceof MalformedPackFile ? { message: error.message } : undefined;
}

export function buildModelPacksApp(service: ModelPacksService): Hono {
  const app = new Hono();

  const settle = (c: Context, run: () => PackResult) => {
    try {
      const result = run();
      return result.ok ? c.json(result.view) : c.json({ error: result.reason }, 409);
    } catch (error) {
      const refused = refusal(error);
      if (!refused) throw error;
      return c.json({ error: refused.message }, 409);
    }
  };

  app.get(MODEL_PACKS_PATH, (c) => {
    try {
      return c.json(service.view());
    } catch (error) {
      const refused = refusal(error);
      if (!refused) throw error;
      return c.json({ error: refused.message }, 409);
    }
  });

  app.put(`${MODEL_PACKS_PATH}/active`, async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as { id?: unknown } | undefined;
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!id) return c.json({ error: "id must name a pack." }, 400);
    return settle(c, () => service.setActive(id));
  });

  app.post(MODEL_PACKS_PATH, async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as
      | { name?: unknown; models?: unknown }
      | undefined;
    if (!body) return c.json({ error: "A pack needs a name and a model for each tier." }, 400);
    return settle(c, () => service.create(body));
  });

  app.delete(`${MODEL_PACKS_PATH}/:id`, (c) => settle(c, () => service.remove(c.req.param("id"))));

  return app;
}
