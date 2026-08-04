/**
 * Signing in, as a sequence of HTTP requests.
 *
 * The rule this module exists to keep: a token never leaves the server. The
 * browser drives the flow — it asks us to start one, it shows the human a URL
 * and maybe a code, it comes back with a pasted code or a poll — and at no
 * point does it need to hold the credential that results. What comes back out
 * of here is flow metadata: where to go, what to type, how long to wait,
 * whether it worked.
 *
 * That is not a promise about how carefully the routes are written. It is a
 * property of `toSessionView`, which is the only way a session becomes a
 * response body, and which names every field it copies. A credential added to a
 * session tomorrow is not in that list, so it does not get out. The alternative
 * — building responses by spreading the session and deleting the secrets — is
 * the same guarantee written so that forgetting one line breaks it silently.
 */

import { safeReason } from "../safe-reason.ts";
import type { CredentialStore, ProviderConnection } from "./credentials.ts";
import type { ProviderLoginFlows } from "./flows.ts";
import {
  DEFAULT_LOGIN_SESSION_TTL_MS,
  type LoginSession,
  type LoginSessionStatus,
  type LoginSessionStore,
} from "./login-sessions.ts";
import { PROVIDERS, PROVIDER_IDS, type LoginKind, type ProviderId } from "./providers.ts";

/** A refusal with the HTTP status it deserves. */
export class LoginRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LoginRequestError";
    this.status = status;
  }
}

/**
 * Everything the browser learns about a login in progress.
 *
 * Note what is absent: no access token, no refresh token, no PKCE verifier, no
 * device auth id.
 */
export interface LoginSessionView {
  sessionId: string;
  provider: ProviderId;
  status: LoginSessionStatus;
  /** Where the human goes to approve. Only while the flow is still open. */
  url?: string;
  /** The short code they type there, for the device flow. */
  userCode?: string;
  instructions?: string;
  /** How long to wait before polling again, in ms. */
  nextPollMs?: number;
  /** ms epoch after which this flow is dead. */
  expiresAt?: number;
  /** Why it failed, in words fit to show a human. */
  error?: string;
}

/** A provider, how it signs in, and whether it currently is. */
export interface ProviderFlowView extends ProviderConnection {
  loginKind: LoginKind;
}

/**
 * The one place a session turns into a response body.
 *
 * An allowlist, on purpose. See the note at the top of this file.
 */
export function toSessionView(session: LoginSession): LoginSessionView {
  const view: LoginSessionView = {
    sessionId: session.id,
    provider: session.provider,
    status: session.status,
  };

  if (session.status === "pending") {
    view.url = session.instruction.url;
    view.expiresAt = session.expiresAt;
    if (session.instruction.userCode !== undefined) view.userCode = session.instruction.userCode;
    if (session.instruction.instructions !== undefined) {
      view.instructions = session.instruction.instructions;
    }
    if (session.instruction.nextPollMs !== undefined) {
      view.nextPollMs = session.instruction.nextPollMs;
    }
  }

  if (session.error !== undefined) view.error = session.error;

  return view;
}

export interface ProviderLoginServiceOptions {
  sessions: LoginSessionStore;
  credentials: CredentialStore;
  flows: ProviderLoginFlows;
  now?: () => number;
  sessionTtlMs?: number;
}

export class ProviderLoginService {
  private readonly sessions: LoginSessionStore;
  private readonly credentials: CredentialStore;
  private readonly flows: ProviderLoginFlows;
  private readonly now: () => number;
  private readonly sessionTtlMs: number;

  constructor(options: ProviderLoginServiceOptions) {
    this.sessions = options.sessions;
    this.credentials = options.credentials;
    this.flows = options.flows;
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_LOGIN_SESSION_TTL_MS;
  }

  /** Every provider, how it signs in, and whether it currently is. */
  listFlows(): ProviderFlowView[] {
    return PROVIDER_IDS.map((provider) => ({
      ...this.credentials.status(provider),
      loginKind: PROVIDERS[provider].loginKind,
    }));
  }

  async startLogin(ownerId: string, provider: ProviderId): Promise<LoginSessionView> {
    const ttlDeadline = this.now() + this.sessionTtlMs;

    if (PROVIDERS[provider].loginKind === "paste-code") {
      const start = await this.flows.startAnthropicLogin();
      const session = this.sessions.create({
        ownerId,
        provider,
        instruction: { url: start.url },
        state: { kind: "paste-code", verifier: start.verifier },
        expiresAt: ttlDeadline,
      });
      return toSessionView(session);
    }

    const pending = await this.flows.startCodexDeviceLogin();
    const session = this.sessions.create({
      ownerId,
      provider,
      instruction: {
        url: pending.url,
        userCode: pending.userCode,
        instructions: pending.instructions,
        nextPollMs: pending.intervalMs,
      },
      state: { kind: "device-code", pending },
      // The device authorization has its own deadline; the session must not
      // outlive it, and must not outlive our own ceiling either.
      expiresAt: Math.min(pending.deadlineAt, ttlDeadline),
    });
    return toSessionView(session);
  }

  /** Finish a paste-code flow with what the human copied back. */
  async completeLogin(
    ownerId: string,
    sessionId: string,
    code: string,
  ): Promise<LoginSessionView> {
    const session = this.requireOwnedSession(sessionId, ownerId);

    // Which flow this is comes from the provider, not from the stored state: a
    // settled session has dropped its state, and answering "wrong flow" to
    // somebody asking about a login that already succeeded would be a lie.
    if (PROVIDERS[session.provider].loginKind !== "paste-code") {
      throw new LoginRequestError(
        400,
        `${PROVIDERS[session.provider].name} sign-in finishes by polling, not by pasting a code.`,
      );
    }
    if (session.status !== "pending" || session.state.kind !== "paste-code") {
      return toSessionView(session);
    }

    const trimmed = code.trim();
    if (trimmed.length === 0) {
      throw new LoginRequestError(400, "Paste the code from the authorization page.");
    }

    const verifier = session.state.verifier;
    try {
      const credentials = await this.flows.completeAnthropicLogin(trimmed, verifier);
      this.credentials.connectOAuth(session.provider, credentials);
      return this.settle(session, "complete");
    } catch (error) {
      return this.settle(session, "failed", safeFailureReason(describeFailure(error)));
    }
  }

  /** Ask once whether a device flow has been approved yet. */
  async pollLogin(ownerId: string, sessionId: string): Promise<LoginSessionView> {
    const session = this.requireOwnedSession(sessionId, ownerId);

    if (PROVIDERS[session.provider].loginKind !== "device-code") {
      throw new LoginRequestError(
        400,
        `${PROVIDERS[session.provider].name} sign-in finishes by pasting a code, not by polling.`,
      );
    }
    // A page that keeps polling a finished flow gets the finished answer, and
    // the provider is not asked again.
    if (session.status !== "pending" || session.state.kind !== "device-code") {
      return toSessionView(session);
    }

    const result = await this.flows.pollCodexDeviceLogin(session.state.pending);

    if (result.status === "complete") {
      this.credentials.connectOAuth(session.provider, result.credentials);
      return this.settle(session, "complete");
    }
    if (result.status === "failed") {
      return this.settle(session, "failed", safeFailureReason(result.error));
    }

    session.instruction = { ...session.instruction, nextPollMs: result.nextPollMs };
    this.sessions.save(session);
    return toSessionView(session);
  }

  /** Look a flow up again — the page reloaded, or a poll got lost. */
  getSession(ownerId: string, sessionId: string): LoginSessionView {
    return toSessionView(this.requireOwnedSession(sessionId, ownerId));
  }

  /**
   * The fallback path for a person who would rather paste a key than sign in.
   * Same store, same lookup, same disconnect — just the other credential kind.
   */
  saveApiKey(provider: ProviderId, key: string): ProviderConnection {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      throw new LoginRequestError(400, "An API key cannot be empty.");
    }
    this.credentials.connectApiKey(provider, trimmed);
    return this.credentials.status(provider);
  }

  disconnect(provider: ProviderId): ProviderConnection {
    this.credentials.disconnect(provider);
    return this.credentials.status(provider);
  }

  private requireOwnedSession(sessionId: string, ownerId: string): LoginSession {
    const session = this.sessions.loadOwnedSession(sessionId, ownerId);
    // Somebody else's flow and a flow that never existed are the same answer.
    if (!session) throw new LoginRequestError(404, "No such sign-in is in progress.");
    return session;
  }

  /**
   * End a flow. The secret half is dropped at the same moment, so a settled
   * session is inert: there is nothing left in it worth stealing.
   */
  private settle(
    session: LoginSession,
    status: Exclude<LoginSessionStatus, "pending">,
    error?: string,
  ): LoginSessionView {
    session.status = status;
    session.state = { kind: "settled" };
    if (error !== undefined) session.error = error;
    this.sessions.save(session);
    return toSessionView(session);
  }
}

function describeFailure(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Sign-in failed.";
}

/**
 * A failed sign-in says why, within limits. The limits — first line, capped,
 * dropped if it looks like it is carrying a secret — are `safeReason`, which
 * the voice lane shares; what belongs here is only what a sign-in says when
 * the provider's own words cannot be repeated.
 */
export function safeFailureReason(reason: string): string {
  return safeReason(reason, "Sign-in failed.");
}
