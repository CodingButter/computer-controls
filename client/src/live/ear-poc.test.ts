import { describe, expect, it } from "vitest";

import { alwaysWakeWord, createAmplitudeVad, deafWakeWord, pocEarChain } from "./ear-poc.ts";

function frame(...samples: number[]) {
  return { samples: new Int16Array(samples), sampleRate: 16_000 };
}

describe("the detectors that are not the matcher", () => {
  it("hears loud frames and not quiet ones", () => {
    const vad = createAmplitudeVad(500);
    expect(vad.isSpeech(frame(2_000, -3_000, 2_500))).toBe(true);
    expect(vad.isSpeech(frame(10, -20, 15))).toBe(false);
    expect(vad.isSpeech(frame())).toBe(false);
  });

  it("has a wake-word detector that never hears the phrase, so speech stays home", () => {
    // A false negative costs a repeated sentence; a false positive costs audio
    // leaving the machine. So the closed direction always answers no.
    expect(deafWakeWord.heard(frame(1, 2, 3))).toBe(false);
  });

  it("has a wake-word detector that always hears it, for testing past the gate", () => {
    expect(alwaysWakeWord.heard(frame(1, 2, 3))).toBe(true);
  });

  it("assembles a chain that cannot open on its own", () => {
    const chain = pocEarChain();
    expect(chain.vad.isSpeech(frame(9_000))).toBe(true);
    expect(chain.wakeWord).toBe(deafWakeWord);
  });
});
