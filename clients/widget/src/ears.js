/**
 * The widget's ears: the hub's own wake gate, running where the microphone
 * now lives.
 *
 * The chain is the vendored live module's, unchanged: an amplitude VAD on
 * every frame, utterances buffered locally, and a fingerprint matcher asked
 * only about complete utterances. The gate's property survives the move
 * intact — no frame leaves this machine until the gate opens — because the
 * gate is the same code, and the only thing downstream of its onForward
 * callback is the mouth.
 *
 * There used to be a transcriber in here, in a worker, and a text match
 * against a list of spellings of "hey mastra". It is gone. It cost eighty
 * megabytes, several hundred milliseconds per utterance, and it locked the
 * owner of this machine out of it by rendering his wake phrase as "he
 * mastered" — a failure no list of spellings can be made long enough to fix.
 * The phrase is a shape now: cepstral frames, compared by subsequence DTW
 * against the templates the hub holds.
 *
 * The templates come from the hub because the hub is where they are trained.
 * The widget is a click-through orb with no keyboard; it cannot show a person
 * a form. It asks what to listen for, and a widget that gets no answer holds
 * no templates and hears nothing — deaf rather than trigger-happy.
 *
 * The plug is the arbitration Jamie named: when another client opens a voice
 * session, this widget stops listening; when that session closes, it resumes.
 * Plugged ears drop frames before the gate ever sees them — a plugged widget
 * is not buffering a wake word to act on later.
 */

import { WakeGate } from "./vendor/live/gate.js";
import { createAmplitudeVad, deafWakeWord } from "./vendor/live/ear-poc.js";
import { createFingerprintDetector } from "./vendor/live/fingerprint.js";

/** The capture rate: the protocol's, the model's, and the context's, at once. */
export const CAPTURE_RATE = 16_000;

/**
 * Assemble the gate the way the hub assembles it, around this matcher.
 *
 * The default when no wake word is supplied is the deaf one, not a permissive
 * one. Assembling a chain is not the same as knowing what to listen for, and a
 * gate that opened on anything while its templates were still in flight would
 * be a microphone with an excuse.
 *
 * @param {{
 *   events: { onOpen: Function, onIdle: Function, onForward: Function },
 *   vad?: { isSpeech: Function, reset: Function },
 *   wakeWord?: { heard: Function, reset: Function },
 *   quietPeriodMs?: number,
 *   hold?: () => boolean,
 * }} deps
 */
export function createEarChain({ events, vad, wakeWord, quietPeriodMs, hold }) {
  return new WakeGate({
    vad: vad ?? createAmplitudeVad(),
    wakeWord: wakeWord ?? deafWakeWord,
    events,
    quietPeriodMs,
    hold,
  });
}

/**
 * Ask the shell for the hub's templates and build the matcher around them.
 *
 * Every failure lands in the same place: no templates. A hub that is down, a
 * person who has not enrolled, a body that arrived malformed — all of them
 * produce a detector that never fires, because the alternative to a deaf
 * widget is not a helpful one, it is one that opens on the dog.
 *
 * @returns {Promise<{ heard: Function, reset: Function }>}
 */
export async function loadWakeWord() {
  const bridge = globalThis.widget;
  if (!bridge?.wakeTemplates) return deafWakeWord;
  const answer = await bridge.wakeTemplates().catch(() => null);
  const templates = Array.isArray(answer?.templates) ? answer.templates : [];
  console.log(`[wake] ${templates.length} template(s) from the hub`);
  return createFingerprintDetector(templates);
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

  const gate = createEarChain({
    wakeWord: await loadWakeWord(),
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
      stream.getTracks().forEach((track) => track.stop());
      void capture.close();
    },
  };
}
