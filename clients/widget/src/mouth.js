/**
 * The widget's mouth: opened by the wake gate, dialed with a hub-minted
 * token, closed by silence.
 *
 * The same architecture as the orb page's mouth, reshaped around what the
 * widget already has. The orb page's press is this widget's wake word, so
 * nothing here asks for a microphone — the ears own it, and the gate hands
 * frames to this mouth only while it is open. The token rides the
 * bridge instead of an HTTP client, because the renderer never learns the
 * hub's port twice. And the lane is the widget's one existing socket rather
 * than a second one: the mouth borrows it, speaks the voice words on it, and
 * hands it back.
 *
 * Deliberately a copy of the orb page's small helpers rather than an import:
 * this is a separate process with no build step, and the same parity
 * reasoning that keeps state-machine.js a tested copy applies here — except
 * these helpers reshape rather than mirror, so they are owned, not vendored.
 */

import { geminiLiveProvider } from "./vendor/live/session.js";
import {
  ANSWER_PREFIX,
  ANSWER_SUFFIX,
  DISPATCH_ACK,
  PROGRESS_PREFIX,
  PROGRESS_SUFFIX,
  realtimeConfig,
} from "./vendor/live/live.js";

/**
 * What a lane frame means to a mouth waiting on its asks — the exact-keys
 * discipline the hub applies, applied back. A frame with a stowaway field,
 * a missing field, or a wrong type is null: noise, not an instruction.
 */
export function interpretLaneFrame(frame) {
  if (!frame || typeof frame !== "object") return null;
  const keys = Object.keys(frame);
  if (keys.length !== 3) return null;
  if (frame.type !== "progress" && frame.type !== "answer") return null;
  if (typeof frame.id !== "string" || !frame.id) return null;
  if (typeof frame.text !== "string" || !frame.text) return null;
  return { kind: frame.type, id: frame.id, text: frame.text };
}

/** How an answer or progress line is framed for the voice to speak. */
export function frameForVoice(kind, text) {
  return kind === "answer"
    ? ANSWER_PREFIX + text + ANSWER_SUFFIX
    : PROGRESS_PREFIX + text + PROGRESS_SUFFIX;
}

/** 16-bit little-endian PCM to Float32, for the playback graph. */
export function floatFromPcm16(bytes) {
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 0x8000;
  return out;
}

/** A gate frame becomes wire bytes: the Int16Array's own octets, no copy. */
export function bytesFromFrame(frame) {
  return new Uint8Array(frame.samples.buffer, frame.samples.byteOffset, frame.samples.length * 2);
}

/**
 * Open the mouth.
 *
 * Order matters and is the same order the orb page settled on: the lane's
 * voice_open first, because it is what plugs other ears and must be said
 * before any audio can flow; then the token; then the dial. The wake
 * utterance's transcript is sent as the first turn, so the person who said
 * "Mastra, what's the weather" is answered rather than asked to repeat
 * themselves — the audio that carried the question was spent deciding to
 * open, which is the privacy design working as intended.
 *
 * @param {{
 *   lane: { send: (frame: object) => void, isOpen: () => boolean },
 *   mintToken: () => Promise<{ token?: string, model?: string, error?: string }>,
 *   transcript: string,
 *   onCaption?: Function, onState?: Function, onReason?: Function,
 *   onDismiss?: Function,
 * }} deps
 * @returns {Promise<{ forward: (frame: object) => void, deliver: (frame: object) => void, close: () => Promise<void> }>}
 */
export async function openMouth({
  lane,
  mintToken,
  transcript,
  onCaption,
  onState,
  onReason,
  onDismiss,
}) {
  if (!lane.isOpen()) {
    throw new Error("The hub's event lane is down, so the mouth stayed shut.");
  }

  const closers = [];
  const pendingAsks = new Set();
  let open = true;
  const close = async () => {
    if (!open) return;
    open = false;
    // Stale ids must not match a late answer on some future mouth's lane.
    pendingAsks.clear();
    for (const closer of closers.splice(0).reverse()) {
      try {
        await closer();
      } catch {
        // Teardown continues past a closer that failed: a half-open mouth
        // that stops closing is worse than any one resource leaking.
      }
    }
    onState?.("idle");
  };

  try {
    // voice_open before anything can flow; voice_close on the way out. The
    // lane is borrowed, never closed — it is the widget's one socket and the
    // face still needs it after the mouth shuts.
    lane.send({ type: "voice_open" });
    closers.push(() => {
      if (lane.isOpen()) lane.send({ type: "voice_close" });
    });

    // The first mint is done by hand so the token's locked model can be
    // handed to the config; its token is banked so the first dial spends it
    // rather than minting twice. Redials mint fresh: the tokens are
    // single-use. A refusal here is the hub's sentence, rendered verbatim —
    // a page state, not an error.
    const first = await mintToken();
    if (first.error || !first.token) {
      throw new Error(first.error ?? "The token mint answered with nothing.");
    }
    let banked = first.token;

    const playback = new AudioContext({ sampleRate: 24000 });
    closers.push(() => playback.close());
    let playCursor = 0;
    const playing = new Set();

    // Lane words that arrived while the model was speaking. Sending text into
    // a live session mid-generation is a barge: Gemini abandons the sentence
    // it was saying to obey the new turn. Live QA heard exactly that — answers
    // cut off by their own progress updates. So while audio is playing, lane
    // words queue here and flush when the playback drains.
    const heldWords = [];
    const flushHeldWords = () => {
      while (heldWords.length) {
        const held = heldWords.shift();
        void session.sendText(frameForVoice(held.kind, held.text));
      }
    };

    const speak = (bytes) => {
      const samples = floatFromPcm16(bytes);
      if (!samples.length) return;
      const buffer = playback.createBuffer(1, samples.length, 24000);
      buffer.copyToChannel(samples, 0);
      const source = playback.createBufferSource();
      source.buffer = buffer;
      source.connect(playback.destination);
      const at = Math.max(playback.currentTime, playCursor);
      source.start(at);
      playCursor = at + buffer.duration;
      playing.add(source);
      source.onended = () => {
        playing.delete(source);
        if (playing.size === 0) flushHeldWords();
      };
      onState?.("speaking");
    };
    const bargeIn = () => {
      for (const source of playing) {
        try {
          source.stop();
        } catch {
          // Already ended; stopping it twice is not news.
        }
      }
      playing.clear();
      playCursor = 0;
      onState?.("listening");
    };

    const session = await geminiLiveProvider().connect(
      realtimeConfig({
        apiKey: "",
        model: first.model,
        mintToken: async () => {
          if (banked) {
            const token = banked;
            banked = undefined;
            return token;
          }
          const fresh = await mintToken();
          if (fresh.error || !fresh.token) {
            throw new Error(fresh.error ?? "The token mint answered with nothing.");
          }
          return fresh.token;
        },
        events: {
          onAudio: speak,
          onBargeIn: bargeIn,
          onTranscript: (text, speaker) => {
            onCaption?.(text, speaker);
            // Relayed so faces that are not mouths can render it. Text the
            // session already produced — never audio.
            if (lane.isOpen()) lane.send({ type: "caption", text });
          },
          onFunctionCall: (call) => {
            // The model decided the user meant to stop. No function result is
            // sent — the same precedent as the refusal path — and the close
            // goes through the renderer, which owns the face's state and the
            // ear chain this mouth is only one half of. A second dismissal
            // while already closing is a harmless no-op: close() is idempotent
            // and closeMouth() has already dropped the reference.
            if (call.name === "stop_listening") {
              onDismiss?.();
              void close();
              return;
            }
            // The lane is checked BEFORE the acknowledgement: DISPATCH_ACK
            // promises the model a result is coming, and a promise made over
            // a dead lane is an answer the user waits for forever.
            if (!lane.isOpen()) {
              void session.sendFunctionResult(
                call.id,
                "The hub could not be reached, so nothing was done. Tell the user that plainly.",
              );
              return;
            }
            void session.sendFunctionResult(call.id, DISPATCH_ACK);
            pendingAsks.add(call.id);
            lane.send({ type: "ask", id: call.id, request: String(call.args.request ?? "") });
          },
          onRefusal: (reason) => {
            onReason?.(reason);
            void close();
          },
        },
      }),
    );
    closers.push(() => session.close());

    // The question that opened the gate, answered instead of repeated.
    if (transcript) void session.sendText(transcript);

    session.unmute();
    onState?.("listening");

    return {
      /** A gate frame, while the gate is open. Bytes on the wire, this one place. */
      forward(frame) {
        session.sendAudio(bytesFromFrame(frame));
      },
      /** A lane frame, routed here by the renderer that owns the socket. */
      deliver(frame) {
        const meaning = interpretLaneFrame(frame);
        // Only this mouth's own asks are spoken; the lane broadcasts, and a
        // mouth relaying another mouth's answers would speak twice.
        if (!meaning || !pendingAsks.has(meaning.id)) return;
        if (meaning.kind === "answer") {
          pendingAsks.delete(meaning.id);
          // An answer supersedes the progress it outran: a queued "working
          // on it" spoken after the result would be the mouth narrating
          // backwards.
          for (let i = heldWords.length - 1; i >= 0; i -= 1) {
            if (heldWords[i].kind === "progress" && heldWords[i].id === meaning.id) {
              heldWords.splice(i, 1);
            }
          }
        }
        if (playing.size > 0) {
          heldWords.push(meaning);
          return;
        }
        void session.sendText(frameForVoice(meaning.kind, meaning.text));
      },
      /** True while the model's answer is still coming out of the speaker. */
      speaking() {
        return playing.size > 0;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
