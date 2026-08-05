/**
 * One mouth. Audio is a queue, never a mixer.
 *
 * Two sounds at once is not a degraded version of one sound — it is a different
 * product, and a worse one. Everything below follows from that: an utterance
 * that has started plays to completion, a second utterance waits, and the only
 * thing permitted to cut a playing utterance short is the human interrupting,
 * because a person talking over the assistant is a person who has stopped
 * listening and there is nothing left to protect.
 *
 * A dropped utterance is preferable to an overlapped one, so `barge` clears what
 * is waiting as well as what is playing. Coming back from an interruption with a
 * queue of stale sentences is the failure this avoids.
 */

/** A sound the orb can make, whether a cached clip or a streamed response. */
export type Utterance = {
  /** Names the utterance for tests and for the event stream. */
  id: string;
  /** Where it came from. Filler is interruptible by the real thing; speech is not. */
  kind: "filler" | "speech";
  /** Plays the audio and resolves when it has finished. */
  play(signal: AbortSignal): Promise<void>;
};

export type MouthEvents = {
  onStart?(utterance: Utterance): void;
  onEnd?(utterance: Utterance): void;
  onIdle?(): void;
};

/**
 * The queue.
 *
 * `speak` returns a promise that settles when that utterance has finished or was
 * abandoned, so a caller can sequence against it without knowing whether it ever
 * reached the speaker.
 */
export class Mouth {
  #queue: { utterance: Utterance; done: () => void }[] = [];
  #playing: { utterance: Utterance; controller: AbortController } | undefined;
  #draining = false;
  #idleWaiters: (() => void)[] = [];
  readonly #events: MouthEvents;

  constructor(events: MouthEvents = {}) {
    this.#events = events;
  }

  get speaking(): boolean {
    return this.#playing !== undefined;
  }

  /** What is playing right now, if anything. */
  get current(): Utterance | undefined {
    return this.#playing?.utterance;
  }

  /** How many utterances are waiting behind the one playing. */
  get waiting(): number {
    return this.#queue.length;
  }

  /**
   * Resolves when the mouth has nothing left to say.
   *
   * The queue is what keeps two sounds from overlapping, but anything that
   * would *provoke* a new sound has to line up too — a signal pushed into the
   * realtime session while the orb is mid-sentence makes the provider abandon
   * the sentence it was already speaking, which is an interruption the queue
   * never sees. Callers on that side wait here first.
   */
  whenIdle(): Promise<void> {
    if (!this.#playing && this.#queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  speak(utterance: Utterance): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#queue.push({ utterance, done: resolve });
      void this.#drain();
    });
  }

  /**
   * The human started talking. Stop, and forget what was queued.
   *
   * This is the only interruption in the design. It is not a general-purpose
   * cancel: nothing in the hub calls it except the path that detects a person
   * speaking over the assistant.
   */
  barge(): void {
    this.#playing?.controller.abort();
    const abandoned = this.#queue;
    this.#queue = [];
    for (const entry of abandoned) entry.done();
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        const next = this.#queue.shift();
        if (!next) break;

        const controller = new AbortController();
        this.#playing = { utterance: next.utterance, controller };
        this.#events.onStart?.(next.utterance);
        try {
          await next.utterance.play(controller.signal);
        } catch {
          // A speaker that failed is not a reason to abandon the queue behind
          // it; the next utterance gets its turn either way.
        }
        this.#events.onEnd?.(next.utterance);
        this.#playing = undefined;
        next.done();
      }
      this.#events.onIdle?.();
      const waiters = this.#idleWaiters;
      this.#idleWaiters = [];
      for (const resolve of waiters) resolve();
    } finally {
      this.#draining = false;
    }
  }
}
