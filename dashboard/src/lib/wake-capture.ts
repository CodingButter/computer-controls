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
 */

/** The rate the whole product captures at. Not a preference — the matcher's. */
export const CAPTURE_RATE = 16_000;

/** Where the hub serves the worklet every microphone in this product uses. */
export const CAPTURE_WORKLET_PATH = "/orb-capture-worklet.js";

/** How long one take records for. Long enough for two words said slowly. */
export const TAKE_MS = 2_500;

export type RecordTake = (options?: { maxMs?: number }) => Promise<Int16Array>;

/**
 * Open the microphone, collect one take, close everything behind it.
 *
 * The stream and the context are torn down in the same tick the samples are
 * handed back: a page that leaves a live microphone open between takes is a
 * recording light that stays on while nobody is recording.
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
    node.port.onmessage = (event: MessageEvent) => {
      chunks.push(new Int16Array(event.data as ArrayBuffer));
    };
    source.connect(node);

    // A silent sink keeps the worklet pulling without echoing the microphone
    // back into the room.
    const silent = capture.createGain();
    silent.gain.value = 0;
    node.connect(silent);
    silent.connect(capture.destination);

    await new Promise((resolve) => setTimeout(resolve, maxMs));
    node.port.onmessage = null;

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
