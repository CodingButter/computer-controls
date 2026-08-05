import { Hono } from "hono";

import type { AgentTurn } from "./chat.ts";
import { UNBUILT_DASHBOARD_PAGE, dashboardIsBuilt, readUiAsset } from "./ui.ts";

export type ClientStatus = {
  /** Tool names the session actually holds, desktop and otherwise. */
  tools: string[];
  /** Operation scope the desktop plugin was mounted at. */
  desktopScope: string;
  /**
   * Which plugins the hub let in and which it found installed on this machine
   * and turned away. Reported as a pair on purpose: a plugin in neither list is
   * one that is not installed, and that is a different fact from one that was
   * declined.
   */
  plugins: { admitted: string[]; refused: string[] };
  /** The brain: which pack this hub declared, which model a turn reaches for, and what each tier resolves to. */
  model: {
    pack: string;
    thinking: string;
    tiers: Record<string, string>;
  };
};

export type AppDeps = {
  chat: AgentTurn;
  uiRoot: string;
  /**
   * The dashboard's built static export. Optional because tests that are not
   * about the dashboard boot without one, and an unbuilt checkout is a normal
   * state — both get the readable refusal at "/" rather than a blank 404.
   */
  dashboardRoot?: string;
  /** Asked per probe rather than captured at boot: the toolbox is the session's, so only the session can answer. */
  status: () => Promise<ClientStatus>;
  /**
   * The provider sign-in surface (routes plus the settings section). Optional
   * only so tests that are not about sign-in can boot without it; the entry
   * module always supplies it.
   */
  auth?: Hono;
  /**
   * The voice routes plus, when voice is off, the reason a person should see.
   * Optional for the same reason auth is; the entry module always supplies it.
   */
  voice?: { app: Hono; reason?: string };
  /**
   * The orb's routes and, when the orb is off, why. Same shape as voice because
   * it is the same promise: a face that cannot run says so, and the typed lane
   * keeps working regardless.
   */
  orb?: { app: Hono; reason?: string };
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

  app.get("/api/health", async (c) =>
    c.json({
      ok: true,
      ...(await deps.status()),
      ...(deps.voice
        ? {
            voice: deps.voice.reason
              ? { enabled: false, reason: deps.voice.reason }
              : { enabled: true },
          }
        : {}),
      ...(deps.orb
        ? {
            orb: deps.orb.reason
              ? { enabled: false, reason: deps.orb.reason }
              : { enabled: true },
          }
        : {}),
    }),
  );

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
  if (deps.voice) app.route("/", deps.voice.app);
  if (deps.orb) app.route("/", deps.orb.app);

  app.get("*", (c) => {
    // The hub's own static root answers first — chat, the orb, the vendored
    // modules — but without its old index fallback: public/ no longer owns
    // "/", so a miss here falls through to the dashboard instead of answering
    // with a page that moved.
    const fromPublic = readUiAsset(deps.uiRoot, c.req.path, { spaFallback: false });
    if (fromPublic) {
      return c.body(fromPublic.body as unknown as ArrayBuffer, 200, {
        "content-type": fromPublic.contentType,
      });
    }

    if (deps.dashboardRoot && dashboardIsBuilt(deps.dashboardRoot)) {
      const fromDashboard = readUiAsset(deps.dashboardRoot, c.req.path, { spaFallback: true });
      // With the fallback on, the only way to miss is a traversal — and a
      // traversal is refused, not redirected to a page.
      if (!fromDashboard) return c.text("Not found", 404);
      return c.body(fromDashboard.body as unknown as ArrayBuffer, 200, {
        "content-type": fromDashboard.contentType,
      });
    }

    // No export on disk: refused with the reason and the fix, never a blank
    // 404 — a person landing here mid-setup deserves a map.
    return c.text(UNBUILT_DASHBOARD_PAGE, 503);
  });

  return app;
}
