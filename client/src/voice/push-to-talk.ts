import { VOICE_SPEAKER } from "./session-voice.ts";

/** What a recorder hands back: the bytes, and what container they are in. */
export type Recording = {
  audio: Blob;
  /** One of Whisper's accepted containers. Browsers differ: Chrome and Firefox
   * record webm, Safari records mp4. The recorder knows which; nobody else
   * should be guessing. */
  filetype: "webm" | "mp4" | "mp3" | "wav" | "m4a" | "mpeg" | "mpga";
};

export type VoiceTransport = {
  agentId: string;
  /** Mirrors the server's own default. Never hardcode `/api` downstream: a
   * deployment is free to mount the API somewhere else. */
  apiPrefix?: string;
  fetch: typeof globalThis.fetch;
};

export type PushToTalkPorts = {
  transport: VoiceTransport;
  record: () => Promise<Recording>;
  /** Puts the transcript into the conversation and returns what the agent said
   * back. Deliberately the same call typing a message makes. */
  sendUserTurn: (text: string) => Promise<string>;
  play: (audio: Blob) => Promise<void>;
};

export type VoiceAvailability =
  | { available: true; speakers: string[] }
  | { available: false; reason: string };

export type TurnResult =
  | { spoke: true; transcript: string; reply: string }
  | { spoke: false; reason: string };

const HEARD_NOTHING =
  "Nothing was transcribed, so nothing was sent. Try again closer to the mic.";

function base({ apiPrefix = "/api", agentId }: VoiceTransport): string {
  return `${apiPrefix}/agents/${encodeURIComponent(agentId)}/voice`;
}

/**
 * Asks whether this session can speak at all, and answers with a reason when it
 * cannot.
 *
 * The speakers route is the probe rather than a trial `speak` because it is the
 * only one of the three that answers a missing provider calmly: it swallows the
 * voice error and returns an empty list. `listen` reports the same condition as
 * a 500, which is not a status a UI should have to interpret as "you have not
 * connected an OpenAI account yet".
 */
export async function probeVoice(
  transport: VoiceTransport,
  disabledReason: string,
): Promise<VoiceAvailability> {
  const response = await transport.fetch(`${base(transport)}/speakers`);
  if (!response.ok) {
    return { available: false, reason: disabledReason };
  }

  const speakers = (await response.json()) as Array<{ voiceId: string }>;
  if (!Array.isArray(speakers) || speakers.length === 0) {
    return { available: false, reason: disabledReason };
  }

  return { available: true, speakers: speakers.map((s) => s.voiceId) };
}

/**
 * One press of the button: record, transcribe, say it into the conversation,
 * speak the answer back.
 *
 * The transcript enters as an ordinary user turn — no voice marker, no separate
 * channel — because "tell me my most recent email" has to mean the same thing
 * spoken as typed. The agent underneath never learns how the words arrived.
 */
export function createPushToTalk(ports: PushToTalkPorts) {
  const { transport, record, sendUserTurn, play } = ports;
  const url = base(transport);

  async function press(): Promise<TurnResult> {
    const recording = await record();

    const heard = new FormData();
    // Multipart, not base64-in-JSON: the server adapter turns a File field into
    // a Buffer before the route's `{ audio: unknown }` schema ever sees it, and
    // the provider only ever wanted bytes plus a container name.
    heard.append("audio", recording.audio, `audio.${recording.filetype}`);
    heard.append("options", JSON.stringify({ filetype: recording.filetype }));

    const listened = await transport.fetch(`${url}/listen`, {
      method: "POST",
      body: heard,
    });
    if (!listened.ok) {
      return { spoke: false, reason: await failureReason(listened) };
    }

    const { text: transcript } = (await listened.json()) as { text: string };
    if (!transcript?.trim()) {
      // An empty turn is worse than a failed one: the agent would answer a
      // question nobody asked.
      return { spoke: false, reason: HEARD_NOTHING };
    }

    const reply = await sendUserTurn(transcript);

    const spoken = await transport.fetch(`${url}/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: reply, speakerId: VOICE_SPEAKER }),
    });
    if (!spoken.ok) {
      // The words already reached the conversation; only the audio was lost.
      return { spoke: false, reason: await failureReason(spoken) };
    }

    await play(await spoken.blob());

    return { spoke: true, transcript, reply };
  }

  return { press, probe: (reason: string) => probeVoice(transport, reason) };
}

async function failureReason(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    return parsed.error ?? parsed.message ?? body;
  } catch {
    return body || `The voice route answered ${response.status}.`;
  }
}
