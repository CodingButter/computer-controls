// The ear's engine room: Moonshine tiny English, ONNX on WASM, in a worker.
//
// This file is the only place in the widget where a speech model runs, and it
// runs entirely on this machine: remote model loading is disabled outright,
// every asset resolves to a file vendored beside this page, and the worker's
// whole protocol is "samples in, text out". The privacy property upstream —
// no frame leaves the machine until the gate opens — depends on this file
// having no network surface, which is why the pins below are code and not
// configuration.
//
// A worker rather than the page because transcription is hundreds of
// milliseconds of arithmetic, and the page is busy being a face: an orb that
// froze every time somebody nearby finished a sentence would look broken.
//
// English only, and that is a licence boundary, not a shortcut: Moonshine's
// English weights are MIT and can ship; the multilingual ones are
// non-commercial and cannot. The `languages` declaration travels with every
// ready message so the seam stays visible where live/ear.ts put it.

import { env, pipeline } from "./vendor/ear/lib/transformers.min.js";

// Local files or nothing. A missing model is a widget with no ear — never a
// widget that quietly phones Hugging Face at first run.
env.allowRemoteModels = false;
env.allowLocalModels = true;
// file:// breaks Cache.put, and a cache of files already on disk is pointless.
env.useBrowserCache = false;
env.localModelPath = new URL("./vendor/ear/model/", import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = new URL("./vendor/ear/lib/", import.meta.url).href;
// One thread, deliberately: more would need SharedArrayBuffer, which needs
// COOP/COEP, and the spike proved a 17-second utterance transcribes in under
// a second without any of that fight.
env.backends.onnx.wasm.numThreads = 1;

/** The one model. q4 because the q8 decoder graph fails session creation on
 * this onnxruntime-web build (proven in the segment-05 spike). */
const MODEL_ID = "onnx-community/moonshine-tiny-ONNX";

const transcriber = pipeline("automatic-speech-recognition", MODEL_ID, {
  dtype: "q4",
  device: "wasm",
});

transcriber.then(
  () => self.postMessage({ kind: "ready", languages: ["en"] }),
  (error) => self.postMessage({ kind: "dead", error: String(error?.message ?? error) }),
);

self.onmessage = async (event) => {
  const { id, samples } = event.data ?? {};
  if (typeof id !== "string") return;
  try {
    // 16-bit PCM to the Float32 the model eats. The gate already fixed the
    // rate at 16 kHz — the capture context's rate — which is also the rate
    // Moonshine was trained at, so no resampling happens here or anywhere.
    const pcm = new Int16Array(samples);
    const audio = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) audio[i] = pcm[i] / 32768;
    const asr = await transcriber;
    const result = await asr(audio);
    self.postMessage({ kind: "transcript", id, text: String(result?.text ?? "") });
  } catch (error) {
    // The gate treats a failed transcription as a CLOSED gate; this message
    // is what lets it make that decision instead of waiting forever.
    self.postMessage({ kind: "transcript-failed", id, error: String(error?.message ?? error) });
  }
};
