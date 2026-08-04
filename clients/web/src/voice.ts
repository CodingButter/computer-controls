/**
 * Voice: record audio with MediaRecorder, send to POST /turn, play the reply.
 *
 * Request/response (not streaming) for milestone 1. The phone captures audio,
 * uploads it, and receives a spoken reply. Barge-in / streaming is a follow-on.
 */

export class VoiceError extends Error {}

export interface VoiceClient {
  /** Record audio until stop() is called. */
  start(): Promise<void>;
  /** Stop recording, send to /turn, return the audio reply bytes. */
  stop(): Promise<Blob>;
  /** Whether currently recording. */
  readonly recording: boolean;
}

/**
 * Create a voice client that records from the microphone, uploads to /turn,
 * and returns the spoken reply.
 *
 * @param serverUrl  Base URL of the server
 * @param token      Bearer token from /session
 */
export function createVoiceClient(
  serverUrl: string,
  token: string,
): VoiceClient {
  const url = new URL(serverUrl);
  const base = `${url.protocol}//${url.host}`;
  let mediaRecorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let recording = false;

  return {
    get recording() {
      return recording;
    },

    async start() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];

      // Prefer webm/opus (Chrome/Firefox); fall back to whatever the browser offers.
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "";

      mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.start();
      recording = true;
    },

    async stop(): Promise<Blob> {
      if (!mediaRecorder || !recording) {
        throw new VoiceError("Not recording");
      }

      const stopped = new Promise<void>((resolve) => {
        mediaRecorder!.onstop = () => resolve();
      });

      mediaRecorder.stop();
      await stopped;
      recording = false;

      // Stop all audio tracks so the mic indicator turns off.
      mediaRecorder.stream.getTracks().forEach((t) => t.stop());

      const audioBlob = new Blob(chunks, { type: chunks[0]?.type ?? "audio/webm" });
      const formData = new FormData();
      formData.append("audio", audioBlob, "audio.webm");

      const resp = await fetch(`${base}/turn`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new VoiceError(body.error ?? `HTTP ${resp.status}`);
      }

      return await resp.blob();
    },
  };
}
