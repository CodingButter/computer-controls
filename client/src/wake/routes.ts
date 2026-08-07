/**
 * Where a voice print is enrolled and where every listening client reads it.
 *
 * Two verbs and nothing else. The dashboard records three takes, scores them
 * with the same arithmetic the gate uses, and PUTs the result. The widget, the
 * dashboard's own orb, and anything else that grows a microphone GET the bank
 * when their ears start. One shape, one owner, one place to forget it.
 *
 * The hub never records. It has no microphone and no opinion about how a take
 * was captured — it holds features and hands them back, which is the whole
 * reason this is a file store behind two routes rather than a service.
 */

import { Hono } from "hono";

import {
  enrolledTemplates,
  parseWakeTemplateState,
  type WakeTemplateState,
  type WakeTemplateStore,
} from "./templates.ts";

export const WAKE_TEMPLATES_PATH = "/api/wake/templates";

export function buildWakeApp(store: WakeTemplateStore): Hono {
  const app = new Hono();

  app.get(WAKE_TEMPLATES_PATH, (c) => c.json<WakeTemplateState>(store.read()));

  app.put(WAKE_TEMPLATES_PATH, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Expected a JSON body with a templates array." }, 400);
    }

    const incoming = parseWakeTemplateState(body);
    // Counted on the person's own takes, not the whole bank: the shipped
    // shapes are always in there, so counting them would let a body full of
    // nothing usable report success to somebody watching a progress bar.
    if (enrolledTemplates(incoming).length === 0) {
      // Saving nothing would silently un-enrol a person who is standing there
      // watching a success message. If they meant to forget their voice, that is
      // a different sentence, and this product does not have it yet.
      return c.json(
        { error: "No usable templates in that body. Nothing was saved." },
        422,
      );
    }

    return c.json<WakeTemplateState>(store.save(incoming));
  });

  return app;
}
