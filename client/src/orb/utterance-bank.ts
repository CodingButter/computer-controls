/**
 * The utterance bank: acknowledgements, synthesized once and kept.
 *
 * The gap between a person finishing a sentence and a model beginning to answer
 * is real, and it is the gap that makes an assistant feel slow. A short "on it"
 * costs nothing to play and buys most of that gap back, but only if the clip is
 * already on disk — synthesizing an acknowledgement at the moment you need it
 * spends exactly the round trip it was supposed to hide.
 *
 * So the bank is a cache with a rule: a filler clip is played from disk or not
 * played at all. There is no lazy-synthesis fallback here on purpose, because a
 * fallback is how a cache quietly stops being one. Filling the bank is a
 * separate, deliberate act (`fill`), run once when the product's voice is
 * chosen.
 */

import type { IntentClass } from "./ear.ts";

/** Which shelf of the bank a clip sits on. */
export type ClipClass = "acknowledge" | "thinking" | "listening" | "query";

/** A cached clip, as bytes plus how long it buys. */
export type Clip = {
  id: string;
  class: ClipClass;
  audio: Uint8Array;
  durationMs: number;
};

/**
 * What the product says while it is getting ready to say something real.
 *
 * The text lives here rather than in a config file because these are lines of
 * product voice, not settings — changing them changes what the thing sounds
 * like, and that belongs in a diff somebody reads.
 */
export const CLIP_TEXT: Readonly<Record<ClipClass, readonly string[]>> = {
  acknowledge: ["on it", "sure", "got it"],
  thinking: ["let me check", "one moment", "uhuh"],
  listening: ["mm", "uhuh", "go on"],
  query: ["hm?", "sorry?", "say again?"],
};

/**
 * Which shelf an intent reaches for.
 *
 * A command gets an acknowledgement because the person wants to know it was
 * heard. A question gets a thinking clip because the honest thing to signal is
 * work, not agreement. A bare wake word gets a query — the assistant has nothing
 * to acknowledge yet and asking is better than guessing. Small talk gets nothing
 * at all: the realtime provider answers small talk directly and fast, and a
 * filler in front of a fast answer is just a stutter.
 */
export function clipClassFor(intent: IntentClass): ClipClass | undefined {
  switch (intent) {
    case "command":
      return "acknowledge";
    case "question":
      return "thinking";
    case "bare-wake":
      return "query";
    case "small-talk":
      return undefined;
  }
}

/** Where the bank keeps its bytes. A directory on disk in the hub. */
export interface ClipStore {
  read(id: string): Promise<Clip | undefined>;
  write(clip: Clip): Promise<void>;
  list(): Promise<string[]>;
}

/** The one-time synthesis step. Runs when the bank is filled, never at play time. */
export interface ClipSynthesizer {
  synthesize(text: string): Promise<{ audio: Uint8Array; durationMs: number }>;
}

function clipId(clipClass: ClipClass, index: number): string {
  return `${clipClass}-${index}`;
}

export class UtteranceBank {
  readonly #store: ClipStore;
  /** Injected so a test gets a deterministic pick instead of a lucky one. */
  readonly #pick: (count: number) => number;

  constructor(store: ClipStore, pick: (count: number) => number = (count) => Math.floor(Math.random() * count)) {
    this.#store = store;
    this.#pick = pick;
  }

  /**
   * Synthesize every clip the bank does not already hold.
   *
   * Idempotent by design: filling a full bank costs a directory listing and no
   * synthesis calls, so it is safe to run at every boot.
   */
  async fill(synthesizer: ClipSynthesizer): Promise<{ synthesized: number; kept: number }> {
    const present = new Set(await this.#store.list());
    let synthesized = 0;
    let kept = 0;

    for (const [clipClass, lines] of Object.entries(CLIP_TEXT) as [ClipClass, readonly string[]][]) {
      for (const [index, text] of lines.entries()) {
        const id = clipId(clipClass, index);
        if (present.has(id)) {
          kept += 1;
          continue;
        }
        const { audio, durationMs } = await synthesizer.synthesize(text);
        await this.#store.write({ id, class: clipClass, audio, durationMs });
        synthesized += 1;
      }
    }
    return { synthesized, kept };
  }

  /**
   * A clip for this intent, or nothing.
   *
   * Randomised within the class so the same command twice does not produce the
   * same sound twice — a filler that is always identical stops reading as speech
   * and starts reading as a notification tone.
   */
  async clipFor(intent: IntentClass): Promise<Clip | undefined> {
    const clipClass = clipClassFor(intent);
    if (!clipClass) return undefined;
    return this.clipFrom(clipClass);
  }

  /** A clip straight off a named shelf, for callers whose reason is not an intent. */
  async clipFrom(clipClass: ClipClass): Promise<Clip | undefined> {
    const count = CLIP_TEXT[clipClass].length;
    const start = this.#pick(count);
    for (let offset = 0; offset < count; offset += 1) {
      const clip = await this.#store.read(clipId(clipClass, (start + offset) % count));
      if (clip) return clip;
    }
    // An empty shelf is silence, not a synthesis call. Being briefly quiet is a
    // smaller failure than turning the cache into a live provider dependency.
    return undefined;
  }
}
