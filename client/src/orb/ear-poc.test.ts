import { describe, expect, it } from "vitest";

import { createAmplitudeVad, deafEar, pocEarChain } from "./ear-poc.ts";

function frame(...samples: number[]) {
  return { samples: new Int16Array(samples), sampleRate: 16_000 };
}

describe("the proof-of-concept ear chain", () => {
  it("hears loud frames and not quiet ones", () => {
    const vad = createAmplitudeVad(500);
    expect(vad.isSpeech(frame(2_000, -3_000, 2_500))).toBe(true);
    expect(vad.isSpeech(frame(10, -20, 15))).toBe(false);
    expect(vad.isSpeech(frame())).toBe(false);
  });

  it("has an ear that transcribes nothing, so the wake path cannot open the gate", async () => {
    // An empty transcript is discarded by the gate, never classified open.
    expect(await deafEar.transcribe(frame(1, 2, 3))).toBe("");
    expect(deafEar.languages).toEqual([]);
  });

  it("assembles a whole chain", () => {
    const chain = pocEarChain();
    expect(chain.vad.isSpeech(frame(9_000))).toBe(true);
    expect(chain.classifier.classify("nothing addressed to us").addressed).toBe(false);
  });
});
