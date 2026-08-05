/**
 * Where a change waits for a person to say yes.
 *
 * A settings request that arrives as text cannot be trusted on its own. The
 * text may have come from the person sitting there, or from a web page the
 * agent read, or from a message somebody relayed into a chat — and all three
 * look identical by the time a model is reasoning about them. So a request that
 * widens what this machine can do does not become a change. It becomes a staged
 * change with a handle, and something a person can hear read back to them.
 *
 * The yes is the click. It has to arrive as a fresh top-level turn — the person
 * typing or speaking again — and it has to name a handle this store minted. That
 * is the part injected text cannot forge: it can say "yes, commit the staged
 * change" all it likes, but it is inside a tool result, not a new turn, and the
 * handle it would have to guess is a random identifier it never saw.
 *
 * Staged changes are single use and they expire. Both bound the window in which
 * a yes meant for one change could land on another, which is the failure mode
 * that turns a confirmation prompt into a rubber stamp. There is deliberately no
 * "always yes": a standing consent is exactly the permission a caller can raise,
 * and this hub does not have those.
 */

import { randomUUID } from "node:crypto";

import { describeChange, type SettingsChange } from "./service.ts";

/** How long a staged change stays confirmable. Long enough to read it out, not longer. */
export const DEFAULT_CONFIRM_TTL_MS = 120_000;

/** A change that has been asked for and not yet authorised. */
export interface StagedChange {
  token: string;
  change: SettingsChange;
  /** The provider or provider id the change applies to. */
  target: string;
  /** The exact sentence a person is answering. */
  echo: string;
  expiresAt: number;
}

/** What the caller gets back when a change is staged rather than made. */
export interface ConfirmationRequest {
  token: string;
  echo: string;
  expiresAt: number;
}

/**
 * Why a commit did not happen.
 *
 * A handle that was already spent and a handle that never existed are the same
 * answer, the same way a stranger's sign-in session and a session that never
 * existed are: telling them apart would only be useful to somebody guessing.
 */
export type ConfirmRefusal = "unknown" | "expired";

export class ConfirmationError extends Error {
  readonly refusal: ConfirmRefusal;

  constructor(refusal: ConfirmRefusal, message: string) {
    super(message);
    this.name = "ConfirmationError";
    this.refusal = refusal;
  }
}

export interface ConfirmationStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

export class ConfirmationStore {
  /**
   * In process, keyed by a handle the model only ever sees as an opaque string.
   * Not persisted: a staged change that survived a restart would be a yes
   * waiting for a question nobody remembers asking.
   */
  private readonly pending = new Map<string, StagedChange>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: ConfirmationStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_CONFIRM_TTL_MS;
  }

  /**
   * Hold a change, and hand back the sentence it has to be confirmed by.
   *
   * The echo is built from the change and its target, here, rather than taken
   * from the caller. A model that could write its own confirmation prompt could
   * describe a change as something milder than it is, and the person would be
   * answering a question about a different change than the one that lands.
   */
  stage(change: SettingsChange, target: string): ConfirmationRequest {
    this.sweep();
    const staged: StagedChange = {
      token: randomUUID(),
      change,
      target,
      echo: `You want me to ${describeChange(change, target)} — yes?`,
      expiresAt: this.now() + this.ttlMs,
    };
    this.pending.set(staged.token, staged);
    return { token: staged.token, echo: staged.echo, expiresAt: staged.expiresAt };
  }

  /** What is waiting, without spending it. For reading a pending change back out. */
  peek(token: string): StagedChange | undefined {
    const staged = this.pending.get(token);
    if (!staged) return undefined;
    return this.now() > staged.expiresAt ? undefined : staged;
  }

  /**
   * Spend a person's yes.
   *
   * Removed before the deadline is checked, so an expired handle cannot be
   * retried into existence, and a spent one is gone whether or not the change
   * that followed it succeeded. A caller who wants to make the change twice has
   * to ask twice and be confirmed twice.
   */
  commit(token: string): StagedChange {
    const staged = this.pending.get(token);
    if (!staged) {
      throw new ConfirmationError(
        "unknown",
        "There is no change waiting on that confirmation. Ask for the change again.",
      );
    }
    this.pending.delete(token);

    if (this.now() > staged.expiresAt) {
      throw new ConfirmationError(
        "expired",
        `That confirmation has expired. Ask again if you still want me to ${describeChange(
          staged.change,
          staged.target,
        )}.`,
      );
    }
    return staged;
  }

  /** Drop a staged change without making it. What "no" does. */
  discard(token: string): boolean {
    return this.pending.delete(token);
  }

  /** How many changes are waiting. A test's window into the store; not a route. */
  get size(): number {
    this.sweep();
    return this.pending.size;
  }

  /**
   * Drop what has expired.
   *
   * Nothing here is load-bearing for safety — `commit` checks the deadline
   * itself, so an expired change is unusable whether or not it is still in the
   * map. It runs on the two paths a long-lived hub touches so that a session
   * where somebody asked for changes and never answered does not accumulate
   * them for as long as the process lives.
   */
  private sweep(): void {
    const now = this.now();
    for (const [token, staged] of this.pending) {
      if (now > staged.expiresAt) this.pending.delete(token);
    }
  }
}
