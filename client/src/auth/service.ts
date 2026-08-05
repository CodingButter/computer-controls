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
import { createApiKeyVerifier, type ApiKeyVerifier } from "./key-verification.ts";
import {
  PROVIDER_IDS,
  describeProvider,
  hasLoginFlow,
  type LoginKind,
  type ProviderId,
} from "./providers.ts";

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
  /** Where a person goes to obtain a key, when the provider publishes one. */
  docUrl?: string;
  /**
   * Why the provider refused the credential it has. Present only when we asked
   * and were told no — a credential that authenticates is not a provider that
   * will serve, and a provider we could not reach says nothing either way.
   */
  rejectedReason?: string;
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
  /** Override for tests; defaults to a real request to the provider. */
  verifier?: ApiKeyVerifier;
  now?: () => number;
  sessionTtlMs?: number;
}

export class ProviderLoginService {
  private readonly sessions: LoginSessionStore;
  private readonly credentials: CredentialStore;
  private readonly flows: ProviderLoginFlows;
  private readonly verifier: ApiKeyVerifier;
  private readonly now: () => number;
  private readonly sessionTtlMs: number;

  /**
   * Providers that told us no, and what they said.
   *
   * In memory on purpose: it is a record of an answer we were given, not a
   * property of the credential, and `auth.json` belongs to the SDK. A restart
   * forgets it and the page goes back to reporting what the store knows, which
   * is the truth it can actually stand behind.
   */
  private readonly rejections = new Map<ProviderId, string>();

  constructor(options: ProviderLoginServiceOptions) {
    this.sessions = options.sessions;
    this.credentials = options.credentials;
    this.flows = options.flows;
    this.verifier = options.verifier ?? createApiKeyVerifier();
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_LOGIN_SESSION_TTL_MS;
  }

  /** Every provider, how it signs in, and whether it currently is. */
  listFlows(): ProviderFlowView[] {
    return PROVIDER_IDS.map((provider) => this.flowView(provider));
  }

  private flowView(provider: ProviderId): ProviderFlowView {
    const descriptor = describeProvider(provider);
    const connection = this.credentials.status(provider);
    const view: ProviderFlowView = { ...connection, loginKind: descriptor.loginKind };

    if (descriptor.docUrl !== undefined) view.docUrl = descriptor.docUrl;

    const rejectedReason = this.rejections.get(provider);
    // A rejection only means anything while the credential it was about is
    // still there. Disconnecting clears it, and so does a store changed from
    // somewhere else.
    if (rejectedReason !== undefined && connection.connected) view.rejectedReason = rejectedReason;

    return view;
  }

  async startLogin(ownerId: string, provider: ProviderId): Promise<LoginSessionView> {
    const ttlDeadline = this.now() + this.sessionTtlMs;

    // A provider with no OAuth flow is refused here rather than falling through
    // to the next branch. The branches below are not a default — they are two
    // specific flows, and letting a third provider land in one of them would
    // start Codex's device authorization under Google's name.
    if (!hasLoginFlow(provider)) {
      throw new LoginRequestError(
        400,
        `${describeProvider(provider).name} has no sign-in flow here. Paste a ${describeProvider(provider).name} API key instead.`,
      );
    }

    if (describeProvider(provider).loginKind === "paste-code") {
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
    if (describeProvider(session.provider).loginKind !== "paste-code") {
      throw new LoginRequestError(
        400,
        `${describeProvider(session.provider).name} sign-in finishes by polling, not by pasting a code.`,
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

    if (describeProvider(session.provider).loginKind !== "device-code") {
      throw new LoginRequestError(
        400,
        `${describeProvider(session.provider).name} sign-in finishes by pasting a code, not by polling.`,
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
  async saveApiKey(provider: ProviderId, key: string): Promise<ProviderFlowView> {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      throw new LoginRequestError(400, "An API key cannot be empty.");
    }

    this.credentials.connectApiKey(provider, trimmed);

    // Stored first, then checked. A provider that refuses the key is worth
    // saying out loud, but it is not a reason to throw away what the person
    // pasted — they may have hit a rate limit, or be minutes away from topping
    // up an account, and a key we quietly discarded is a key they have to find
    // again.
    const verification = await this.verifier.verify(describeProvider(provider), trimmed);
    if (verification.status === "rejected") {
      this.rejections.set(provider, verification.reason);
    } else {
      this.rejections.delete(provider);
    }

    return this.flowView(provider);
  }

  disconnect(provider: ProviderId): ProviderFlowView {
    this.credentials.disconnect(provider);
    this.rejections.delete(provider);
    return this.flowView(provider);
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
