/**
 * Recording a wake-word take in the browser.
 *
 * The same capture graph the widget's ears use, for the same reason: no media
 * recorder, no encoder, no blob. `getUserMedia`, an `AudioContext` fixed at the
 * capture rate, and the hub's own `pcm16-capture` worklet, which does one
 * conversion and nothing else. What comes back is raw PCM16 — the shape the
 * feature extractor wants, with no format to guess at.
 *
 * The worklet is fetched from the hub's static root rather than bundled. It is
 * the same file the orb and the widget load, and a second copy compiled into
 * the dashboard is a second copy that can drift.
 *
 * Nothing here keeps the audio. The samples go to the feature extractor, the
 * frames go to the hub, and the recording is dropped with the page.
 *
 * The cues live here too, and that is deliberate. A person walking through an
 * enrolment without watching the screen needs to hear when the microphone
 * opens and closes, and a beep is a sound, which means a playback graph. This
 * file already holds the only context in the dashboard, so the cue is played on
 * that one rather than opening a second — see boundaries.test.ts, which is what
 * keeps that sentence true rather than merely intended.
 */

/** The rate the whole product captures at. Not a preference — the matcher's. */
export const CAPTURE_RATE = 16_000;

/** Where the hub serves the worklet every microphone in this product uses. */
export const CAPTURE_WORKLET_PATH = "/orb-capture-worklet.js";

/** How long one take records for. Long enough for two words said slowly. */
export const TAKE_MS = 2_500;

/** Rising note: the microphone is open, say it now. */
export const CUE_START_HZ = 880;

/** Falling note: that is the take, stop talking. */
export const CUE_STOP_HZ = 440;

/** Short enough to be a cue and not a noise. */
export const CUE_MS = 120;

/**
 * Silence between the start cue and the first sample kept.
 *
 * Without it the beep is inside the take, and a beep is a far cleaner signal
 * than a spoken phrase — the feature extractor would happily enrol it, and
 * every take would then share a leading tone the gate later expects to hear.
 */
export const CUE_GAP_MS = 80;

export type RecordTake = (options?: { maxMs?: number }) => Promise<Int16Array>;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Play one short note on a context somebody else owns.
 *
 * The context is a parameter, not something this function reaches for, and that
 * is the whole design: a cue player that could open its own context would be
 * the dashboard's second one. The signature makes the rule structural instead
 * of a comment asking nicely.
 *
 * The gain ramps rather than switching, because a square-edged start and stop
 * on a sine wave is a click at each end — two extra sounds nobody asked for.
 */
export function playCue(context: BaseAudioContext, hz: number, ms: number): void {
  const at = context.currentTime;
  const until = at + ms / 1000;

  const oscillator = context.createOscillator();
  oscillator.frequency.value = hz;

  const level = context.createGain();
  level.gain.setValueAtTime(0, at);
  level.gain.linearRampToValueAtTime(0.2, at + 0.01);
  level.gain.setValueAtTime(0.2, until - 0.01);
  level.gain.linearRampToValueAtTime(0, until);

  oscillator.connect(level);
  level.connect(context.destination);
  oscillator.start(at);
  oscillator.stop(until);
}

/**
 * Open the microphone, collect one take, close everything behind it.
 *
 * The stream and the context are torn down in the same tick the samples are
 * handed back: a page that leaves a live microphone open between takes is a
 * recording light that stays on while nobody is recording.
 *
 * The take is bracketed by two cues. The start cue finishes before the first
 * sample is kept and the stop cue is awaited before the context closes —
 * closing a context mid-note is a beep the person never hears, which is the
 * same as no beep at all.
 */
export async function recordTake({ maxMs = TAKE_MS }: { maxMs?: number } = {}): Promise<Int16Array> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });

  const capture = new AudioContext({ sampleRate: CAPTURE_RATE });
  try {
    await capture.audioWorklet.addModule(CAPTURE_WORKLET_PATH);
    const source = capture.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(capture, "pcm16-capture");

    const chunks: Int16Array[] = [];
    source.connect(node);

    // A silent sink keeps the worklet pulling without echoing the microphone
    // back into the room.
    const silent = capture.createGain();
    silent.gain.value = 0;
    node.connect(silent);
    silent.connect(capture.destination);

    // The graph is already running; nothing is kept until the cue has finished
    // sounding, so what the take contains is a person and not a beep.
    playCue(capture, CUE_START_HZ, CUE_MS);
    await wait(CUE_MS + CUE_GAP_MS);

    node.port.onmessage = (event: MessageEvent) => {
      chunks.push(new Int16Array(event.data as ArrayBuffer));
    };
    await wait(maxMs);
    node.port.onmessage = null;

    playCue(capture, CUE_STOP_HZ, CUE_MS);
    await wait(CUE_MS);

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Int16Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    return samples;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    void capture.close();
  }
}
