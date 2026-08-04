/**
 * Fill the orb's utterance bank: the one-time synthesis step.
 *
 * The bank's rule is that a filler clip plays from disk or not at all, so
 * something has to put the clips on disk. This is that something. It runs the
 * real `UtteranceBank.fill()` against a Gemini TTS synthesizer and the real
 * disk store — the same store the hub reads at play time — so what this script
 * writes is exactly what the mouth will play.
 *
 * Idempotent: a full bank costs a directory listing and zero synthesis calls.
 * Run it again after adding lines to CLIP_TEXT and it fills only the gaps.
 *
 *   node scripts/fill-orb-clips.mjs
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UtteranceBank } from "../client/src/orb/utterance-bank.ts";
import { diskClipStore } from "../client/src/orb/host.ts";

const TTS_MODEL = "gemini-3.1-flash-tts-preview";
/** The clips must match what the speaker plays: raw pcm, 24 kHz, mono, s16le. */
const SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = path.join(repoRoot, "client");

async function googleApiKey() {
  const authPath = path.join(
    process.env.HOME ?? "",
    ".local/share/mastracode/auth.json",
  );
  const auth = JSON.parse(await readFile(authPath, "utf8"));
  const entry = auth["apikey:google"];
  const key = typeof entry === "string" ? entry : entry?.key;
  if (!key) throw new Error(`No apikey:google in ${authPath} — the bank stays empty.`);
  return key;
}

function geminiSynthesizer(key) {
  return {
    async synthesize(text) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
              },
            },
          }),
        },
      );
      if (response.status === 429) {
        // The per-model limit is 10 requests a minute and the bank has 12
        // lines. Waiting out the window is cheaper than a second run.
        const body = await response.text();
        const seconds = Number(/retry in (\d+)/i.exec(body)?.[1] ?? 60) + 2;
        console.log(`  rate limited — waiting ${seconds}s before "${text}"`);
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        return this.synthesize(text);
      }
      if (!response.ok) {
        throw new Error(`TTS refused "${text}": ${response.status} ${await response.text()}`);
      }
      const body = await response.json();
      const inline = body.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData;
      if (!inline?.data) throw new Error(`TTS returned no audio for "${text}".`);
      if (inline.mimeType && !inline.mimeType.startsWith("audio/")) {
        throw new Error(`TTS returned ${inline.mimeType} for "${text}", not audio.`);
      }
      const audio = Buffer.from(inline.data, "base64");
      const durationMs = Math.round((audio.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000);
      console.log(`  "${text}" — ${durationMs}ms, ${audio.length} bytes`);
      return { audio: new Uint8Array(audio), durationMs };
    },
  };
}

const bank = new UtteranceBank(diskClipStore(clientRoot));
const result = await bank.fill(geminiSynthesizer(await googleApiKey()));
console.log(`filled: ${result.synthesized} synthesized, ${result.kept} already on disk`);
console.log(`bank at ${path.join(clientRoot, ".mastracode/orb-clips")}`);
