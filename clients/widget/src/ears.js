/**
 * The widget's ears: the hub's own wake chain, running where the microphone
 * now lives.
 *
 * The chain is the vendored live module's, unchanged: an amplitude VAD on
 * every frame, utterances buffered locally, the local transcriber asked only
 * about complete utterances, and the classifier's WAKE_WORDS text match as
 * the wake decision. The gate's property survives the move intact — no frame
 * leaves this machine until the gate opens — because the gate is the same
 * code, and the only thing downstream of its onForward callback is the mouth.
 *
 * Two deliberate substitutions, both named:
 *
 * - The Tier 0.5 wake-word detector is `alwaysWakeWord`, not openWakeWord.
 *   The plan ships the wake path at the fidelity the hub had — VAD, local
 *   transcription, WAKE_WORDS text match, classifier — with the one upgrade
 *   that the transcriber is now real. Every utterance reaches the local
 *   model; the classifier's text match is what decides "addressed". The cost
 *   is local CPU on speech that was never for us; the property that matters
 *   — nothing on the network without the name — is the classifier's.
 *
 * - The ear is a worker, because transcription is hundreds of milliseconds
 *   of arithmetic and this page is busy being a face.
 *
 * The plug is the arbitration Jamie named: when another client opens a voice
 * session, this widget stops listening; when that session closes, it resumes.
 * Plugged ears drop frames before the gate ever sees them — a plugged widget
 * is not buffering a wake word to act on later.
 */

import { WakeGate } from "./vendor/live/gate.js";
import { alwaysWakeWord, createAmplitudeVad } from "./vendor/live/ear-poc.js";
import { createWakeWordClassifier } from "./vendor/live/ear.js";

/** The capture rate: the protocol's, the model's, and the context's, at once. */
export const CAPTURE_RATE = 16_000;

/**
 * Wrap the transcription worker in the LocalEar seam from live/ear.ts.
 *
 * English only — the licence boundary rides the declaration, exactly as the
 * seam intends. A worker that failed to boot rejects every transcription,
 * and the gate treats a failed transcription as a closed gate: a dead model
 * can never become audio on the network.
 *
 * @param {{ postMessage: Function, addEventListener: Function }} worker
 */
export function createWorkerEar(worker) {
  let seq = 0;
  const pending = new Map();
  let dead = null;

  worker.addEventListener("message", (event) => {
    const message = event.data ?? {};
    if (message.kind === "dead") {
      dead = String(message.error ?? "The ear's model failed to load.");
      for (const waiter of pending.values()) waiter.reject(new Error(dead));
      pending.clear();
      return;
    }
    if (message.kind !== "transcript" && message.kind !== "transcript-failed") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.kind === "transcript") waiter.resolve(String(message.text ?? ""));
    else waiter.reject(new Error(String(message.error ?? "Transcription failed.")));
  });

  return {
    languages: ["en"],
    /** @param {{ samples: Int16Array, sampleRate: number }} utterance */
    transcribe(utterance) {
      if (dead) return Promise.reject(new Error(dead));
      const id = `t${++seq}`;
      console.log(
        `[ear-debug] utterance ${id}: ${utterance.samples.length} samples (${(utterance.samples.length / utterance.sampleRate).toFixed(2)}s)`,
      );
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        // Sliced first so the transfer donates a copy's buffer, never the
        // gate's own: the utterance the gate handed over is still its to keep.
        const samples = utterance.samples.slice();
        worker.postMessage({ id, samples: samples.buffer }, [samples.buffer]);
      }).then(
        (text) => {
          console.log(`[ear-debug] ${id} transcript: ${JSON.stringify(text)}`);
          return text;
        },
        (error) => {
          console.log(`[ear-debug] ${id} FAILED: ${error?.message ?? error}`);
          throw error;
        },
      );
    },
  };
}

/**
 * Assemble the gate the way the hub assembled it, around this ear.
 *
 * @param {{
 *   ear: { languages: string[], transcribe: Function },
 *   events: { onOpen: Function, onIdle: Function, onForward: Function },
 *   vad?: { isSpeech: Function, reset: Function },
 *   wakeWord?: { heard: Function, reset: Function },
 *   quietPeriodMs?: number,
 * }} deps
 */
export function createEarChain({ ear, events, vad, wakeWord, quietPeriodMs, hold }) {
  return new WakeGate({
    vad: vad ?? createAmplitudeVad(),
    wakeWord: wakeWord ?? alwaysWakeWord,
    ear,
    classifier: createWakeWordClassifier(),
    events,
    quietPeriodMs,
    hold,
  });
}

/**
 * What a lane word means to a pair of ears.
 *
 * The lane's voice words report set transitions, not memberships, and carry
 * no "who" — so the one thing that distinguishes our own session from
 * another client's is whether our own mouth is open when the word arrives.
 * A voice_opened while our mouth is open is the hub confirming us; while it
 * is shut, it is someone else talking, and we plug. voice_closed always
 * unplugs: if our own session was the last one open, listening is exactly
 * what should resume.
 *
 * @param {string} eventType
 * @param {boolean} mouthOpen
 * @returns {"plug" | "unplug" | null}
 */
export function plugDecision(eventType, mouthOpen) {
  if (eventType === "voice_opened" && !mouthOpen) return "plug";
  if (eventType === "voice_closed") return "unplug";
  return null;
}

/**
 * Open the microphone and run the chain against it. Browser-only; everything
 * decidable without a browser lives in the exports above.
 *
 * The mic opens here, at ears-start, not at a press: the widget's consent
 * gesture is installing it and leaving it enabled, and the tray's disable is
 * the honest off. Chromium's echo cancellation is requested so the mouth's
 * own playback does not become the next utterance.
 *
 * @param {{
 *   onOpen: Function, onIdle: Function, onForward: Function,
 *   quietPeriodMs?: number, hold?: () => boolean,
 * }} events
 * @returns {Promise<{ gate: WakeGate, plug: () => void, unplug: () => void, stop: () => void }>}
 */
export async function startEars({ onOpen, onIdle, onForward, quietPeriodMs, hold }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });

  const worker = new Worker(new URL("./ear-worker.js", import.meta.url), { type: "module" });
  const gate = createEarChain({
    ear: createWorkerEar(worker),
    events: { onOpen, onIdle, onForward },
    quietPeriodMs,
    hold,
  });

  const capture = new AudioContext({ sampleRate: CAPTURE_RATE });
  await capture.audioWorklet.addModule(new URL("./vendor/orb-capture-worklet.js", import.meta.url));
  const source = capture.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(capture, "pcm16-capture");

  let plugged = false;
  node.port.onmessage = (event) => {
    // Plugged ears drop the frame HERE, upstream of the gate: not buffered,
    // not considered, gone. Unplugging resumes hearing, not remembering.
    if (plugged) return;
    gate.push({ samples: new Int16Array(event.data), sampleRate: CAPTURE_RATE });
  };
  source.connect(node);
  // A worklet with nothing downstream may be skipped by the graph; the
  // silent gain keeps it live without echoing the mic to the room.
  const silent = capture.createGain();
  silent.gain.value = 0;
  node.connect(silent);
  silent.connect(capture.destination);

  return {
    gate,
    plug() {
      plugged = true;
      // An open gate mid-plug closes: the session it was feeding is being
      // superseded by another client's, and half-forwarding is worse than
      // stopping. An idle gate is left alone — close() on idle would fire
      // onIdle at a mouth that was never open.
      if (gate.isOpen) gate.close();
    },
    unplug() {
      plugged = false;
    },
    stop() {
      node.port.onmessage = null;
      worker.terminate();
      stream.getTracks().forEach((track) => track.stop());
      void capture.close();
    },
  };
}
