import { describe, expect, it, vi } from "vitest";

import { Mouth, type Utterance } from "./mouth.ts";

/**
 * An utterance whose completion the test controls.
 *
 * Resolving by hand rather than by timer is what makes "the second one did not
 * start" an assertion about ordering instead of about scheduling luck.
 */
function pending(id: string, kind: Utterance["kind"] = "speech") {
  let release!: () => void;
  const started = vi.fn();
  const finished = vi.fn();
  const utterance: Utterance = {
    id,
    kind,
    play: (signal) =>
      new Promise<void>((resolve, reject) => {
        started();
        release = () => {
          finished();
          resolve();
        };
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  return { utterance, started, finished, release: () => release() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("test_the_real_response_never_starts_before_the_playing_utterance_ends", () => {
  it("holds the second utterance until the first has finished", async () => {
    const mouth = new Mouth();
    const filler = pending("filler", "filler");
    const speech = pending("speech");

    void mouth.speak(filler.utterance);
    void mouth.speak(speech.utterance);
    await tick();

    expect(filler.started).toHaveBeenCalled();
    expect(speech.started).not.toHaveBeenCalled();

    filler.release();
    await tick();

    expect(speech.started).toHaveBeenCalled();
  });

  it("plays a started utterance to completion rather than truncating it", async () => {
    const order: string[] = [];
    const mouth = new Mouth({
      onStart: (u) => order.push(`start:${u.id}`),
      onEnd: (u) => order.push(`end:${u.id}`),
    });
    const first = pending("first");
    const second = pending("second");

    void mouth.speak(first.utterance);
    void mouth.speak(second.utterance);
    await tick();
    first.release();
    await tick();
    second.release();
    await tick();

    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("never has two utterances in flight, however many are queued", async () => {
    const mouth = new Mouth();
    const clips = [pending("a"), pending("b"), pending("c"), pending("d")];

    for (const clip of clips) void mouth.speak(clip.utterance);
    await tick();

    expect(clips.filter((c) => c.started.mock.calls.length > 0)).toHaveLength(1);
    expect(mouth.waiting).toBe(3);

    clips[0]!.release();
    await tick();
    expect(clips.filter((c) => c.started.mock.calls.length > 0)).toHaveLength(2);
  });

  it("keeps the queue moving when one utterance fails at the speaker", async () => {
    const mouth = new Mouth();
    const broken: Utterance = {
      id: "broken",
      kind: "speech",
      play: async () => {
        throw new Error("no audio device");
      },
    };
    const good = pending("good");

    void mouth.speak(broken);
    void mouth.speak(good.utterance);
    await tick();

    expect(good.started).toHaveBeenCalled();
  });

  it("lets the human barge in — the only interruption there is", async () => {
    const mouth = new Mouth();
    const playing = pending("playing");
    const queued = pending("queued");

    void mouth.speak(playing.utterance);
    void mouth.speak(queued.utterance);
    await tick();

    mouth.barge();
    await tick();

    // Interrupted mid-word, and what was waiting behind it is abandoned rather
    // than resumed: coming back from an interruption with a backlog of stale
    // sentences is the failure this avoids.
    expect(playing.finished).not.toHaveBeenCalled();
    expect(queued.started).not.toHaveBeenCalled();
    expect(mouth.waiting).toBe(0);
    expect(mouth.speaking).toBe(false);
  });

  it("settles every caller's promise when it barges, so nothing hangs", async () => {
    const mouth = new Mouth();
    const playing = pending("playing");
    const queued = pending("queued");

    const first = mouth.speak(playing.utterance);
    const second = mouth.speak(queued.utterance);
    await tick();

    mouth.barge();

    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });

  it("reports what it is saying while it is saying it", async () => {
    const mouth = new Mouth();
    const clip = pending("current");

    void mouth.speak(clip.utterance);
    await tick();

    expect(mouth.speaking).toBe(true);
    expect(mouth.current?.id).toBe("current");

    clip.release();
    await tick();

    expect(mouth.speaking).toBe(false);
    expect(mouth.current).toBeUndefined();
  });
});
