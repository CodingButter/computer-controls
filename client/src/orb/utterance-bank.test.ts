import { describe, expect, it, vi } from "vitest";

import { CLIP_TEXT, UtteranceBank, clipClassFor, type Clip, type ClipStore } from "./utterance-bank.ts";

function memoryStore(seed: Clip[] = []): ClipStore & { writes: Clip[] } {
  const clips = new Map(seed.map((clip) => [clip.id, clip]));
  const writes: Clip[] = [];
  return {
    writes,
    read: async (id) => clips.get(id),
    write: async (clip) => {
      clips.set(clip.id, clip);
      writes.push(clip);
    },
    list: async () => [...clips.keys()],
  };
}

function clip(id: string, clipClass: Clip["class"]): Clip {
  return { id, class: clipClass, audio: new Uint8Array([1, 2, 3]), durationMs: 500 };
}

describe("test_a_filler_clip_plays_from_cache_and_never_from_a_live_synth_call", () => {
  it("serves a cached clip without touching a synthesizer", async () => {
    const store = memoryStore([clip("acknowledge-0", "acknowledge")]);
    const synthesizer = { synthesize: vi.fn() };
    const bank = new UtteranceBank(store, () => 0);

    const found = await bank.clipFor("command");

    expect(found?.id).toBe("acknowledge-0");
    expect(synthesizer.synthesize).not.toHaveBeenCalled();
  });

  it("stays silent rather than synthesizing when the shelf is empty", async () => {
    const bank = new UtteranceBank(memoryStore(), () => 0);

    // An empty bank is briefly quiet. The alternative — a live synthesis call at
    // play time — spends exactly the round trip the clip existed to hide.
    await expect(bank.clipFor("command")).resolves.toBeUndefined();
  });

  it("synthesizes only when the bank is filled, which is a separate act", async () => {
    const store = memoryStore();
    const synthesizer = {
      synthesize: vi.fn(async () => ({ audio: new Uint8Array([9]), durationMs: 400 })),
    };
    const bank = new UtteranceBank(store, () => 0);

    const result = await bank.fill(synthesizer);

    const expected = Object.values(CLIP_TEXT).reduce((sum, lines) => sum + lines.length, 0);
    expect(result.synthesized).toBe(expected);
    expect(synthesizer.synthesize).toHaveBeenCalledTimes(expected);

    // And now the clip is served from disk, with no further synthesis.
    synthesizer.synthesize.mockClear();
    const found = await bank.clipFor("question");
    expect(found).toBeDefined();
    expect(synthesizer.synthesize).not.toHaveBeenCalled();
  });

  it("filling a full bank costs nothing, so it is safe at every boot", async () => {
    const store = memoryStore();
    const synthesizer = {
      synthesize: vi.fn(async () => ({ audio: new Uint8Array([9]), durationMs: 400 })),
    };
    const bank = new UtteranceBank(store, () => 0);

    await bank.fill(synthesizer);
    synthesizer.synthesize.mockClear();
    const second = await bank.fill(synthesizer);

    expect(synthesizer.synthesize).not.toHaveBeenCalled();
    expect(second.synthesized).toBe(0);
    expect(second.kept).toBeGreaterThan(0);
  });
});

describe("picking a clip for what was heard", () => {
  it("acknowledges a command, thinks at a question, and asks back at a bare wake", () => {
    expect(clipClassFor("command")).toBe("acknowledge");
    expect(clipClassFor("question")).toBe("thinking");
    expect(clipClassFor("bare-wake")).toBe("query");
  });

  it("says nothing before small talk, because a filler in front of a fast answer is a stutter", async () => {
    expect(clipClassFor("small-talk")).toBeUndefined();
    const bank = new UtteranceBank(memoryStore([clip("acknowledge-0", "acknowledge")]), () => 0);
    await expect(bank.clipFor("small-talk")).resolves.toBeUndefined();
  });

  it("varies within a class so the same command twice does not sound identical", async () => {
    const store = memoryStore([
      clip("acknowledge-0", "acknowledge"),
      clip("acknowledge-1", "acknowledge"),
      clip("acknowledge-2", "acknowledge"),
    ]);
    let call = 0;
    const bank = new UtteranceBank(store, () => call++ % 3);

    const picks = [
      (await bank.clipFor("command"))?.id,
      (await bank.clipFor("command"))?.id,
      (await bank.clipFor("command"))?.id,
    ];

    expect(new Set(picks).size).toBe(3);
  });

  it("falls to a sibling when the randomly chosen clip is missing from disk", async () => {
    const store = memoryStore([clip("acknowledge-2", "acknowledge")]);
    const bank = new UtteranceBank(store, () => 0);

    const found = await bank.clipFor("command");

    expect(found?.id).toBe("acknowledge-2");
  });
});
