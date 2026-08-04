import { Readable } from "node:stream";
import { Hono } from "hono";
import type { CompositeVoice } from "@mastra/core/voice";

/**
 * The hub has exactly one agent, the session, so the `:agentId` position in
 * the core route shape is a constant rather than a lookup. The path shape is
 * kept anyway (`/api/agents/:agentId/voice/*`) because the ruling names it as
 * the transport, and the browser half (`push-to-talk.ts`) builds these URLs
 * the way it would against a full Mastra server.
 */
export const SESSION_AGENT_ID = "session";

export type VoiceMount = {
  /** The ear and the mouth, or undefined when there is no OpenAI credential. */
  voice?: CompositeVoice;
  /** Why voice is off, phrased for a person; present exactly when voice is not. */
  reason?: string;
};

const VOICE_BASE = `/api/agents/${SESSION_AGENT_ID}/voice`;

/**
 * The three core voice routes, served by the hub's own app.
 *
 * A deviation worth naming: a full Mastra server would serve these itself,
 * resolving the agent from its registry. The hub's agent is a headless Mastra
 * Code session, not a registered core Agent, so nothing in that registry can
 * answer for it. These handlers keep the core route shapes (speakers list,
 * `{ text }` out of listen, audio bytes out of speak) and hand the work to the
 * same `CompositeVoice` the ruling prescribes.
 *
 * The speakers route answers a missing provider calmly (an empty list) because
 * it is the probe the UI uses to decide whether to offer the button at all.
 * The other two refuse loudly, with the reason, because being asked to
 * transcribe with no ear is a caller mistake the UI should have prevented.
 */
export function buildVoiceApp(mount: VoiceMount): Hono {
  const app = new Hono();

  app.get(`${VOICE_BASE}/speakers`, async (c) => {
    if (!mount.voice) return c.json([]);
    return c.json(await mount.voice.getSpeakers());
  });

  app.post(`${VOICE_BASE}/listen`, async (c) => {
    if (!mount.voice) return c.json({ error: mount.reason }, 400);

    const form = await c.req.formData().catch(() => undefined);
    const audio = form?.get("audio");
    if (!(audio instanceof File)) {
      return c.json({ error: "audio is required" }, 400);
    }
    const options = JSON.parse(String(form?.get("options") ?? "{}")) as {
      filetype?: string;
    };

    const bytes = Buffer.from(await audio.arrayBuffer());
    const text = await mount.voice.listen(Readable.from(bytes), options);
    return c.json({ text });
  });

  app.post(`${VOICE_BASE}/speak`, async (c) => {
    if (!mount.voice) return c.json({ error: mount.reason }, 400);

    const body = (await c.req.json().catch(() => undefined)) as
      | { text?: unknown; speakerId?: unknown }
      | undefined;
    if (typeof body?.text !== "string" || !body.text.trim()) {
      return c.json({ error: "text is required" }, 400);
    }

    const spoken = await mount.voice.speak(body.text, {
      ...(typeof body.speakerId === "string" ? { speaker: body.speakerId } : {}),
    });

    const chunks: Buffer[] = [];
    for await (const chunk of spoken as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return c.body(new Uint8Array(Buffer.concat(chunks)).buffer, 200, {
      "content-type": "audio/mpeg",
    });
  });

  return app;
}
