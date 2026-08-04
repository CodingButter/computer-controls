/**
 * Login sessions: the flow state that has to survive between HTTP requests.
 *
 * Both flows are two-legged. Anthropic's PKCE login mints a verifier on the way
 * out and needs that same verifier back to exchange the code the human pastes;
 * OpenAI's device login mints a pending record that every subsequent poll has
 * to carry. Neither can live in the browser — the verifier is the secret half
 * of the exchange, and shipping it out would hand a stranger the other end of
 * the flow. So it lives here, on the server, keyed by a session id.
 *
 * Two properties are load-bearing and are the reason this is a module rather
 * than a Map inline in the routes:
 *
 * 1. Ownership. A session belongs to whoever started it. `loadOwnedSession` is
 *    the only way in, and it refuses to answer for anybody else — the same
 *    shape Factory's own `loadOwnedSession` has. A caller who did not start a
 *    flow cannot finish it, and cannot even learn that it exists: a foreign
 *    session and a missing session are the same `undefined`, so the routes have
 *    nothing to leak even if they wanted to.
 *
 * 2. Expiry. A half-finished login is a secret sitting in memory. Both flows
 *    carry their own deadline; sessions past theirs are gone on the next touch.
 *
 * The store is an interface, and this file's implementation keeps sessions in a
 * Map. Local mode is one process serving one person, so a Map is the whole
 * requirement — and when tenant mode arrives, the seam to swap in a database
 * store is this interface rather than a rewrite of the routes.
 */

import { randomUUID } from "node:crypto";

import type { ProviderId } from "./providers.ts";

/** Where a flow has got to. */
export type LoginSessionStatus = "pending" | "complete" | "failed";

/**
 * The secret half of a flow. Never rendered, never returned, never logged.
 */
export type LoginFlowState =
  | { kind: "paste-code"; verifier: string }
  | { kind: "device-code"; pending: DeviceLoginPending }
  /** A finished flow keeps no secret at all. */
  | { kind: "settled" };

/**
 * The pending device-login record, as `startCodexDeviceLogin` returns it.
 *
 * Restated structurally rather than imported so the session store does not
 * depend on the provider SDK to describe its own storage.
 */
export interface DeviceLoginPending {
  deviceAuthId: string;
  userCode: string;
  url: string;
  instructions: string;
  intervalMs: number;
  deadlineAt: number;
}

/** What the browser is allowed to be told about a flow in progress. */
export interface LoginInstruction {
  /** Where the human goes to approve. */
  url: string;
  /** The short code the human types there, for device flows. */
  userCode?: string;
  instructions?: string;
  /** How long to wait before polling again, for device flows. */
  nextPollMs?: number;
}

export interface LoginSession {
  readonly id: string;
  /** Who started it. Only they may finish it. */
  readonly ownerId: string;
  readonly provider: ProviderId;
  status: LoginSessionStatus;
  instruction: LoginInstruction;
  state: LoginFlowState;
  /** Why it failed, in words fit to show a human. */
  error?: string;
  readonly createdAt: number;
  expiresAt: number;
}

export interface CreateLoginSessionInput {
  ownerId: string;
  provider: ProviderId;
  instruction: LoginInstruction;
  state: LoginFlowState;
  expiresAt: number;
}

export interface LoginSessionStore {
  create(input: CreateLoginSessionInput): LoginSession;
  /**
   * The only read. Answers for the owner and nobody else; a session belonging
   * to someone else is reported exactly the way a missing one is.
   */
  loadOwnedSession(id: string, ownerId: string): LoginSession | undefined;
  save(session: LoginSession): void;
  delete(id: string): void;
}

/** How long a flow may sit unfinished before we forget it. */
export const DEFAULT_LOGIN_SESSION_TTL_MS = 15 * 60 * 1000;

export class InMemoryLoginSessionStore implements LoginSessionStore {
  private readonly sessions = new Map<string, LoginSession>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  create(input: CreateLoginSessionInput): LoginSession {
    this.sweep();
    const session: LoginSession = {
      id: randomUUID(),
      ownerId: input.ownerId,
      provider: input.provider,
      status: "pending",
      instruction: input.instruction,
      state: input.state,
      createdAt: this.now(),
      expiresAt: input.expiresAt,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  loadOwnedSession(id: string, ownerId: string): LoginSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    // The whole point. A stranger gets the same answer as a bad id.
    if (session.ownerId !== ownerId) return undefined;
    return session;
  }

  save(session: LoginSession): void {
    this.sessions.set(session.id, session);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}
