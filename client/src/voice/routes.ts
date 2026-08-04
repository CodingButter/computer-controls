import { Readable } from "node:stream";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { CompositeVoice } from "@mastra/core/voice";
import { safeReason } from "../safe-reason.ts";
import type { VoiceProviderView } from "./providers.ts";

/**
 * The hub has exactly one agent, the session, so the `:agentId` position in
 * the core route shape is a constant rather than a lookup. The path shape is
 * kept anyway (`/api/agents/:agentId/voice/*`) because the ruling names it as
 * the transport, and the browser half (`public/app.js`) builds these URLs
 * the way it would against a full Mastra server.
 */
export const SESSION_AGENT_ID = "session";

export type VoiceMount = {
  /** The ear and the mouth, or undefined when there is no usable credential. */
  voice?: CompositeVoice;
  /** Why voice is off, phrased for a person; present exactly when voice is not. */
  reason?: string;
  /**
   * The providers this machine can offer, asked per request rather than
   * captured at boot: connecting an account in the settings section has to
   * change this answer without a restart.
   */
  providers?: () => VoiceProviderView[];
};

const VOICE_BASE = `/api/agents/${SESSION_AGENT_ID}/voice`;

/**
 * Where the settings section reads the list of mouths from.
 *
 * Not under the agent path: which providers this machine could use is a fact
 * about the machine's credentials, true before any agent resolves and unchanged
 * by which one did.
 */
export const VOICE_PROVIDERS_PATH = "/api/voice/providers";

/** What a refusal says when the provider's own words cannot be repeated. */
const PROVIDER_REFUSED = "The voice provider refused the request.";

/** A provider's refusal, carried far enough to become a response. */
class VoiceProviderError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(reason: string, status: ContentfulStatusCode) {
    super(reason);
    this.name = "VoiceProviderError";
    this.status = status;
  }
}

/**
 * Everything the provider does, wrapped.
 *
 * A credential that authenticates is not a provider that will serve: the
 * account behind it can be out of credits, over its rate limit, or simply
 * unreachable, and all three arrive here as a throw from inside somebody else's
 * client. Whether voice is enabled is decided at boot from credential presence;
 * whether OpenAI will answer is decided per request, and this is where that
 * second question gets its answer.
 *
 * The provider's own status is relayed when it has one, so a rate limit still
 * reads as a rate limit. A failure with no status never reached the provider —
 * DNS, a dropped socket — and that is not the caller's mistake, so it is a 502.
 */
async function fromProvider<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    throw new VoiceProviderError(
      safeReason(error instanceof Error ? error.message : String(error), PROVIDER_REFUSED),
      typeof status === "number" && status >= 400 && status <= 599
        ? (status as ContentfulStatusCode)
        : 502,
    );
  }
}

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
 *
 * A provider that is mounted and then refuses is neither of those cases, and
 * `onError` is where it becomes an answer. Nothing in this app is allowed to
 * reach the framework's default handler: a caller holding a text/plain
 * "Internal Server Error" learns nothing it can act on, and the browser half
 * reads these bodies as JSON.
 */
export function buildVoiceApp(mount: VoiceMount): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof VoiceProviderError) {
      return c.json({ error: error.message }, error.status);
    }
    // Not the provider's doing, so it is ours. The caller gets an answer; the
    // stack that would explain it is not the caller's business.
    return c.json({ error: "Voice is temporarily unavailable." }, 500);
  });

  // No key, no offer. An empty list is the honest answer on a machine with no
  // voice credentials at all, and it is the same shape the settings section
  // renders either way.
  app.get(VOICE_PROVIDERS_PATH, (c) => c.json({ providers: mount.providers?.() ?? [] }));

  app.get(`${VOICE_BASE}/speakers`, async (c) => {
    const voice = mount.voice;
    if (!voice) return c.json([]);
    return c.json(await fromProvider(() => voice.getSpeakers()));
  });

  app.post(`${VOICE_BASE}/listen`, async (c) => {
    const voice = mount.voice;
    if (!voice) return c.json({ error: mount.reason }, 400);

    const form = await c.req.formData().catch(() => undefined);
    const audio = form?.get("audio");
    if (!(audio instanceof File)) {
      return c.json({ error: "audio is required" }, 400);
    }
    const options = JSON.parse(String(form?.get("options") ?? "{}")) as {
      filetype?: string;
    };

    const bytes = Buffer.from(await audio.arrayBuffer());
    const text = await fromProvider(() => voice.listen(Readable.from(bytes), options));
    return c.json({ text });
  });

  app.post(`${VOICE_BASE}/speak`, async (c) => {
    const voice = mount.voice;
    if (!voice) return c.json({ error: mount.reason }, 400);

    const body = (await c.req.json().catch(() => undefined)) as
      | { text?: unknown; speakerId?: unknown }
      | undefined;
    if (typeof body?.text !== "string" || !body.text.trim()) {
      return c.json({ error: "text is required" }, 400);
    }
    const text = body.text;
    const speaker = typeof body.speakerId === "string" ? { speaker: body.speakerId } : {};

    // The drain is inside the wrapper with the call. Today's provider buffers
    // the whole response before handing back a stream, so it throws at the
    // await — but one that streamed would throw mid-iteration, and that is the
    // same refusal arriving a few lines later.
    const audio = await fromProvider(async () => {
      const spoken = await voice.speak(text, speaker);
      const chunks: Buffer[] = [];
      for await (const chunk of spoken as AsyncIterable<Buffer | string>) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      return Buffer.concat(chunks);
    });

    return c.body(new Uint8Array(audio).buffer, 200, {
      "content-type": "audio/mpeg",
    });
  });

  return app;
}
