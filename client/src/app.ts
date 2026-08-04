import { Hono } from "hono";

import type { AgentTurn } from "./chat.ts";
import { readUiAsset } from "./ui.ts";

export type ClientStatus = {
  /** Tool names the session actually holds, desktop and otherwise. */
  tools: string[];
  /** Operation scope the desktop plugin was mounted at. */
  desktopScope: string;
};

export type AppDeps = {
  chat: AgentTurn;
  uiRoot: string;
  status: () => ClientStatus;
  /**
   * The provider sign-in surface (routes plus the settings section). Optional
   * only so tests that are not about sign-in can boot without it; the entry
   * module always supplies it.
   */
  auth?: Hono;
};

/**
 * The whole HTTP surface: a health probe, a chat turn, and the page.
 *
 * Deliberately three routes. The client is a hub that rides headless Mastra
 * Code, so anything richer than this belongs to the session underneath rather
 * than to a route here.
 */
export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true, ...deps.status() }));

  app.post("/api/chat", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const message = (body as { message?: unknown } | undefined)?.message;
    if (typeof message !== "string" || !message.trim()) {
      return c.json({ error: "message is required" }, 400);
    }
    const threadId = (body as { threadId?: unknown }).threadId;
    const reply = await deps.chat({
      message,
      ...(typeof threadId === "string" ? { threadId } : {}),
    });
    return c.json(reply);
  });

  // Mounted before the SPA fallback, or the catch-all would swallow the
  // settings section and every sign-in route with a 404-shaped page.
  if (deps.auth) app.route("/", deps.auth);

  app.get("*", (c) => {
    const asset = readUiAsset(deps.uiRoot, c.req.path);
    if (!asset) return c.text("Not found", 404);
    return c.body(asset.body as unknown as ArrayBuffer, 200, {
      "content-type": asset.contentType,
    });
  });

  return app;
}
