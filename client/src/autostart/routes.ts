/**
 * Start on boot, as a setting written where the desktop reads it.
 *
 * The dashboard's toggle does not launch anything and does not talk to the
 * widget: it edits the person's own autostart entry through the platform port,
 * and the session manager does the launching, at the next login, the way it
 * launches everything else. The hub is only the pen — which is why the answer
 * to GET is read from disk, not from memory: the person can delete the entry
 * behind our back, and the toggle must tell the truth about what the desktop
 * will actually do.
 *
 * On an OS whose adapter has no autostart yet, the route answers the honest
 * no with a sentence, the same reason-arm shape pairing and voice use — a
 * capability that is off says so, rather than leaving a dead toggle on the
 * page.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";

import type { HubPlatform } from "../platform/index.ts";

export const AUTOSTART_PATH = "/api/autostart";

/** The entry's basename on disk: `mastra-cc-widget.desktop` under XDG. */
export const WIDGET_AUTOSTART_ID = "mastra-cc-widget";

/** What the person's startup list calls it. */
export const WIDGET_AUTOSTART_NAME = "Mastra CC";

/**
 * The command the session runs: this checkout's widget, under its own
 * Electron. Resolved from this module's location rather than the working
 * directory, because a hub launched from anywhere still owns exactly one
 * widget. The day a package installs the widget somewhere system-wide, this
 * default is the one line packaging replaces.
 */
export function widgetExec(): string {
  const widget = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../clients/widget",
  );
  const electron = path.join(widget, "node_modules", ".bin", "electron");
  return `"${electron}" "${widget}"`;
}

export type AutostartMount = {
  platform: HubPlatform;
  /** The command the entry runs. Injectable so tests never depend on this checkout's layout. */
  exec?: string;
};

/**
 * What the toggle is told. One shape for both verbs, so the page can never
 * show a state the write did not produce: PUT answers with the same read GET
 * would give.
 */
export type AutostartView =
  | { supported: true; enabled: boolean; path: string }
  | { supported: false; reason: string };

export function buildAutostartApp(mount: AutostartMount): Hono {
  const app = new Hono();
  const { platform } = mount;
  const exec = mount.exec ?? widgetExec();
  const refusal = `Start on boot is not supported on ${platform.id} yet.`;

  const view = async (): Promise<AutostartView> => ({
    supported: true,
    enabled: await platform.autostart.read(WIDGET_AUTOSTART_ID),
    path: platform.autostart.path(WIDGET_AUTOSTART_ID),
  });

  app.get(AUTOSTART_PATH, async (c) => {
    if (!platform.supports.autostart) {
      return c.json({ supported: false, reason: refusal } satisfies AutostartView);
    }
    return c.json(await view());
  });

  app.put(AUTOSTART_PATH, async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as
      | { enabled?: unknown }
      | undefined;
    if (typeof body?.enabled !== "boolean") {
      return c.json({ error: "enabled must be true or false" }, 400);
    }
    if (!platform.supports.autostart) return c.json({ error: refusal }, 409);
    await platform.autostart.write(
      { id: WIDGET_AUTOSTART_ID, name: WIDGET_AUTOSTART_NAME, exec },
      body.enabled,
    );
    return c.json(await view());
  });

  return app;
}
