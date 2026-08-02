/**
 * The push lane: the desktop talking first.
 *
 * Everything else in this plugin is pull — the model asks, the service answers.
 * This is the one path where a change on the desktop reaches the model without
 * anybody having called a tool. That is the capability the whole project exists
 * for, and it is why the phase opened with a gate rather than with code.
 *
 * ## Why this polls a socket instead of being pushed to
 *
 * The service is genuinely event-driven — AT-SPI events, no polling of the
 * accessibility tree — and it would be possible to have it push deltas up the
 * socket as JSON-RPC notifications. It does not, deliberately:
 *
 * - Each client asks for what changed *since its own cursor*. A client that was
 *   disconnected, slow, or restarted resumes exactly where it left off. Server
 *   push would have to solve that separately, and would solve it worse.
 * - Delivery becomes idempotent for free. A change is either past a thread's
 *   cursor or it is not; no ledger of "have I mentioned this yet" is required.
 * - The cost being avoided is a local Unix-socket round trip against an answer
 *   the service has already computed. No model, no tree walk. Polling *the
 *   desktop* would be indefensible; polling a precomputed integer is not.
 *
 * The model still gets a push. That is the part that matters.
 *
 * ## Priority is not a free parameter
 *
 * Proven against the runtime in `idle-behavior.gate.test.ts`, not assumed:
 * `medium` and `high` honour `ifIdle: { behavior: 'persist' }` and touch no
 * model, while `low` is deferred into a digest whose sender overrides the idle
 * behaviour and wakes the thread. The quietest-looking priority is the one that
 * starts a headless run. Desktop deltas therefore go out at `medium` for ambient
 * and `high` for interrupt-class, and never at `low`.
 */
import { SignalProvider } from "@mastra/core/signals";

import { Cursors } from "./cursor.ts";

/** A thread this provider is delivering to. */
export interface Target {
  threadId: string;
  resourceId: string;
}

/** The subset of a delta this lane cares about. */
export interface DeltaLike {
  changes: Array<ChangeLike>;
  revision: number;
  complete: boolean;
  oldestHeldRevision?: number;
}

export interface ChangeLike {
  kind: string;
  revision: number;
  summary: string;
  attribution?: string;
  windowId?: string;
  applicationId?: string;
  elementId?: string;
  detail?: Record<string, unknown>;
}

/** What the provider needs from the desktop, kept narrow so it can be faked in tests. */
export interface DesktopSource {
  /** Where the desktop is right now, for positioning a thread that has never listened. */
  revision(): Promise<number>;
  /** What changed since a revision, attributed for the asking client. */
  since(revision: number): Promise<DeltaLike>;
}

/**
 * Kinds that interrupt rather than inform.
 *
 * A window disappearing is the one structural change a worker cannot discover
 * later without consequence: whatever it was about to do in there will fail, and
 * it should hear about that now rather than on its next turn. Everything else in
 * the vocabulary is news — a window opened, focus moved, a value changed — and
 * news travels at ambient priority.
 */
const INTERRUPT_KINDS = new Set(["window-closed"]);

/**
 * Attributions that interrupt regardless of kind.
 *
 * A human touching something is not information to be filed; it is a reason to
 * stop. `user` is not computable until the input-evidence source exists — the
 * service says `unknown` rather than guessing — so this set is presently
 * unreachable in production and deliberately still here, because the routing
 * rule is what is being stated and it should not have to be discovered later.
 */
const INTERRUPT_ATTRIBUTIONS = new Set(["user"]);

export function priorityOf(changes: Array<ChangeLike>): "medium" | "high" {
  for (const change of changes) {
    if (INTERRUPT_KINDS.has(change.kind)) return "high";
    if (change.attribution && INTERRUPT_ATTRIBUTIONS.has(change.attribution)) return "high";
  }
  return "medium";
}

/**
 * What the model is told.
 *
 * Deliberately a summary and not a payload. The model sees only a notification
 * summary until it reads the record, and a wall of change objects in that slot
 * would be noise it cannot act on. The tools already exist for the detail: the
 * summary's job is to be enough to decide whether to look.
 */
export function summarize(delta: DeltaLike): string {
  const lines = delta.changes.slice(0, MAX_SUMMARY_LINES).map(change => `- ${change.summary}`);
  const hidden = delta.changes.length - lines.length;
  if (hidden > 0) lines.push(`- and ${hidden} more`);
  if (!delta.complete) {
    lines.push(
      `- earlier changes were dropped; re-read from revision ${delta.oldestHeldRevision ?? 0}`,
    );
  }
  const headline = delta.changes.length === 1 ? "The desktop changed" : "The desktop changed in several ways";
  return `${headline} while you were not looking:\n${lines.join("\n")}`;
}

const MAX_SUMMARY_LINES = 6;

/** Threads are subscribed against a single external identity, as memorease does. */
const EXTERNAL_RESOURCE_ID = "desktop-control:desktop";

export interface DesktopProviderOptions {
  source: DesktopSource;
  /** How often to ask the service what changed. A local socket round trip; see the file header. */
  pollIntervalMs?: number;
  /** Injected so tests can watch what was sent without reaching into the base class. */
  onSent?: (target: Target, priority: "medium" | "high", summary: string) => void;
}

export const DEFAULT_POLL_MS = 1000;

export class DesktopSignalProvider extends SignalProvider<string> {
  readonly id = "desktop-control:deltas";
  readonly name = "Desktop changes";
  readonly pollInterval: number;

  readonly #source: DesktopSource;
  readonly #cursors = new Cursors();
  readonly #onSent: DesktopProviderOptions["onSent"];
  #pollInFlight = false;
  #kickPending = false;

  constructor(options: DesktopProviderOptions) {
    super();
    this.#source = options.source;
    this.pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.#onSent = options.onSent;
  }

  /**
   * Public wrapper around the protected base `subscribe`.
   *
   * Without at least one subscription the poll iterates nothing and no delta can
   * ever be delivered — the failure mode being guarded against is a provider
   * that is running, healthy, and silent forever.
   *
   * Returns true only when this call added a new subscription, so callers can
   * kick a poll exactly once per thread instead of once per invocation.
   */
  subscribeThread(threadId: string, resourceId: string): boolean {
    const target = { threadId, resourceId };
    if (this.hasSubscription(target, EXTERNAL_RESOURCE_ID)) return false;
    this.subscribe(target, EXTERNAL_RESOURCE_ID);
    return true;
  }

  /**
   * Poll now rather than waiting out the interval.
   *
   * The base class's timer has no leading tick, so a thread that subscribes just
   * after one fires would wait a full interval before the desktop could reach
   * it. A poll already running cannot cover this thread — it snapshotted its
   * subscription list before this thread joined — so the kick is recorded and
   * drained on the way out instead of being dropped.
   */
  async kickPoll(): Promise<void> {
    if (this.#pollInFlight) {
      this.#kickPending = true;
      return;
    }
    await this.poll(this.getSubscriptions());
  }

  async poll(subscriptions: Array<Target>): Promise<void> {
    // A timer tick landing during another poll is dropped rather than queued:
    // the next tick covers the same subscriptions and each pass is idempotent
    // against the cursor, so the tick is redundant rather than lost.
    if (this.#pollInFlight) return;
    this.#pollInFlight = true;
    try {
      for (const target of subscriptions) {
        await this.#pollOne(target);
      }
    } finally {
      this.#pollInFlight = false;
    }
    if (this.#kickPending) {
      this.#kickPending = false;
      await this.poll(this.getSubscriptions());
    }
  }

  async #pollOne(target: Target): Promise<void> {
    try {
      const cursor = this.#cursors.get(target.threadId);
      if (cursor === undefined) {
        // A thread that has never listened starts from now. Its first
        // notification should be the first thing that happens after it began
        // listening, not a recital of everything this desktop has ever done.
        this.#cursors.advance(target.threadId, await this.#source.revision());
        return;
      }

      const delta = await this.#source.since(cursor);
      // Advance before sending. A send that throws must not cause the same
      // changes to be announced again on the next pass; a delta that was
      // computed and then lost is a missed notification, while one announced
      // twice is a lie about the desktop having changed twice.
      this.#cursors.advance(target.threadId, delta.revision);
      if (delta.changes.length === 0) return;

      await this.#send(target, delta);
    } catch {
      // Fail-soft, always. The desktop service being down, restarting, or
      // mid-reconnect must degrade this lane to silence rather than break the
      // session that happens to be running.
    }
  }

  async #send(target: Target, delta: DeltaLike): Promise<void> {
    const priority = priorityOf(delta.changes);
    const summary = summarize(delta);
    const self = this as unknown as { notify: (signal: unknown, target: unknown) => Promise<unknown> };
    await self.notify(
      {
        source: "desktop",
        kind: "delta",
        summary,
        priority,
        // Collapse rather than stack: while a desktop delta is still pending for
        // this thread, a newer one replaces it in place. A thread that has not
        // taken a turn in ten minutes should find one current account of the
        // desktop waiting, not forty stale ones.
        coalesceKey: `desktop:delta:${target.threadId}`,
      },
      {
        threadId: target.threadId,
        resourceId: target.resourceId,
        // Never wake an idle thread: a background-woken run has no controller
        // session and the model resolver throws. Proven, not assumed — see
        // idle-behavior.gate.test.ts.
        ifIdle: { behavior: "persist" },
      },
    );
    this.#onSent?.(target, priority, summary);
  }
}
