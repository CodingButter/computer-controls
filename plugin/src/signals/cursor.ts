/**
 * Where each thread's view of the desktop has got to.
 *
 * A thread is told what changed since the revision it last heard about, which
 * makes delivery idempotent for free: a change is either past your cursor or it
 * is not, and no ledger of "have I mentioned this yet" is needed to prevent a
 * change being announced twice. The service's revision counter is the dedup key.
 *
 * A thread with no cursor yet starts at the current revision rather than at
 * zero. Its first notification should be the first thing that happens *after* it
 * started listening, not a recital of everything that ever happened on this
 * desktop.
 */
export class Cursors {
  readonly #at = new Map<string, number>();

  /** Whether this thread has ever been positioned. */
  has(threadId: string): boolean {
    return this.#at.has(threadId);
  }

  /** Where to ask from. Undefined for a thread that has never been positioned. */
  get(threadId: string): number | undefined {
    return this.#at.get(threadId);
  }

  /**
   * Move a thread's cursor forward. Never backwards: a late-arriving answer from
   * a slow call must not re-announce changes the thread has already been told
   * about.
   */
  advance(threadId: string, revision: number): void {
    const current = this.#at.get(threadId);
    if (current !== undefined && revision <= current) return;
    this.#at.set(threadId, revision);
  }

  /** A thread that has gone away stops being tracked. */
  forget(threadId: string): void {
    this.#at.delete(threadId);
  }

  get size(): number {
    return this.#at.size;
  }
}
