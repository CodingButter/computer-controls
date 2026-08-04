/**
 * The two login flows, behind one seam.
 *
 * We are not implementing OAuth here. `@mastra/code-sdk` already ships both
 * flows split into request-spanning halves — `startAnthropicLogin` /
 * `completeAnthropicLogin` for the paste-code exchange, `startCodexDeviceLogin`
 * / `pollCodexDeviceLogin` for the device one — precisely because a server
 * driving them from HTTP requests cannot hold a flow open in a single call the
 * way a terminal can. This file exists only to name that surface so the service
 * above it can be exercised against a mock, and so nothing else in the package
 * imports the provider SDK directly.
 */

import type { OAuthCredentials } from "@mastra/code-sdk/auth/types";
import {
  completeAnthropicLogin,
  startAnthropicLogin,
} from "@mastra/code-sdk/auth/providers/anthropic";
import {
  pollCodexDeviceLogin,
  startCodexDeviceLogin,
} from "@mastra/code-sdk/auth/providers/openai-codex";

import type { DeviceLoginPending } from "./login-sessions.ts";

export interface AnthropicLoginStart {
  /** Authorization URL for the human to open. */
  url: string;
  /** PKCE code verifier — the half that stays on the server. */
  verifier: string;
}

export type DevicePollResult =
  | { status: "complete"; credentials: OAuthCredentials }
  | { status: "pending"; nextPollMs: number }
  | { status: "failed"; error: string };

export interface ProviderLoginFlows {
  startAnthropicLogin(): Promise<AnthropicLoginStart>;
  completeAnthropicLogin(input: string, verifier: string): Promise<OAuthCredentials>;
  startCodexDeviceLogin(): Promise<DeviceLoginPending>;
  pollCodexDeviceLogin(pending: DeviceLoginPending): Promise<DevicePollResult>;
}

/** The real thing: the SDK's own primitives, unwrapped. */
export const sdkLoginFlows: ProviderLoginFlows = {
  startAnthropicLogin: () => startAnthropicLogin(),
  completeAnthropicLogin: (input, verifier) => completeAnthropicLogin(input, verifier),
  startCodexDeviceLogin: () => startCodexDeviceLogin(),
  pollCodexDeviceLogin: (pending) => pollCodexDeviceLogin(pending),
};
