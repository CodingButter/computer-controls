import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { decodeWav, enrollWav } from "../scripts/enroll-wake-sample.mjs";
import { readWakeTemplates } from "./wake-templates.js";

/**
 * The WAV→template CLI, checked without a microphone.
 *
 * A synthetic RIFF/PCM16-mono WAV is generated in-memory so the parser and the
 * enroll round-trip are exercised deterministically. The discipline is the
 * scorer's: numbers in, templates out, and the header that does not describe
 * mono 16-bit PCM is refused rather than coerced.
 */

/** Build a minimal in-memory RIFF WAV (PCM, mono, 16-bit) from Int16 samples. */
const wav = (samples: Int16Array, sampleRate = 16000): Buffer => {
  const dataLength = samples.byteLength;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataLength, 40);
  new Int16Array(buffer.buffer, buffer.byteOffset + 44, samples.length).set(samples);
  return buffer;
};

const ramp = (length: number): Int16Array => {
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i += 1) samples[i] = Math.round(1000 + (15000 * i) / length);
  return samples;
};

/** Build a WAV with an arbitrary number of channels, for rejection tests. */
const wavWithChannels = (samples: Int16Array, channels: number, sampleRate = 16000): Buffer => {
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const dataLength = samples.byteLength;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataLength, 40);
  new Int16Array(buffer.buffer, buffer.byteOffset + 44, samples.length).set(samples);
  return buffer;
};

describe("decodeWav", () => {
  test("parses a mono 16-bit PCM WAV", () => {
    const samples = ramp(16000);
    const { samples: decoded, sampleRate } = decodeWav(wav(samples, 22050));
    expect(sampleRate).toBe(22050);
    expect(decoded.length).toBe(16000);
    expect(decoded[0]).toBe(samples[0]);
    expect(decoded[15999]).toBe(samples[15999]);
  });

  test("refuses a non-RIFF file", () => {
    expect(() => decodeWav(Buffer.from("not a wav at all but long enough to pass the size check padding"))).toThrow(
      /RIFF/,
    );
  });

  test("refuses stereo", () => {
    expect(() => decodeWav(wavWithChannels(ramp(1600), 2))).toThrow(/mono/);
  });

  test("refuses 8-bit", () => {
    const dataLength = 1600;
    const buffer = Buffer.alloc(44 + dataLength);
    buffer.write("RIFF", 0, "ascii");
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write("WAVE", 8, "ascii");
    buffer.write("fmt ", 12, "ascii");
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(16000, 24);
    buffer.writeUInt32LE(16000, 28);
    buffer.writeUInt16LE(1, 32);
    buffer.writeUInt16LE(8, 34); // 8-bit
    buffer.write("data", 36, "ascii");
    buffer.writeUInt32LE(dataLength, 40);
    expect(() => decodeWav(buffer)).toThrow(/16-bit/);
  });
});

describe("enrollWav", () => {
  let dir: string;
  const dataPath = () => path.join(dir, "wake-templates.json");
  const wavPath = () => path.join(dir, "take.wav");

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "enroll-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes one template to an empty data file", () => {
    writeFileSync(wavPath(), wav(ramp(16000)));

    const { template, total } = enrollWav(wavPath(), dataPath(), "hey mastra");
    expect(total).toBe(1);
    expect(template.phrase).toBe("hey mastra");
    expect(template.sampleRate).toBe(16000);
    expect(template.features.length).toBeGreaterThan(0);

    const stored = readWakeTemplates(dataPath());
    expect(stored.templates).toHaveLength(1);
    expect(stored.enrolled).toBe(true);
  });

  test("appends to an existing data file without losing prior templates", () => {
    writeFileSync(wavPath(), wav(ramp(16000)));

    enrollWav(wavPath(), dataPath(), "hey mastra");
    const second = enrollWav(wavPath(), dataPath(), "hey mastra");
    expect(second.total).toBe(2);
    expect(readWakeTemplates(dataPath()).templates).toHaveLength(2);
  });

  test("the written file is valid JSON on disk", () => {
    writeFileSync(wavPath(), wav(ramp(8000)));
    enrollWav(wavPath(), dataPath(), "hey mastra");
    const raw = JSON.parse(readFileSync(dataPath(), "utf8"));
    expect(raw.enrolled).toBe(true);
    expect(raw.templates[0].phrase).toBe("hey mastra");
  });
});
