/**
 * Where a finished login lands.
 *
 * There is exactly one credential store in this product and we did not write
 * it: `AuthStorage` from the SDK, the file-backed `auth.json` that Mastra
 * Code's own TUI already reads and writes. A person who has signed in at the
 * terminal is already signed in here, and a person who signs in here is signed
 * in at the terminal. Inventing a second format would give us two truths about
 * whether someone is logged in, and no way to tell which one is lying.
 *
 * So this module holds no storage of its own. It is the small amount of
 * knowledge that sits above `AuthStorage`: which key a provider files under,
 * which of the two slots a credential went into, and how to take it back out
 * again — including the slot a pasted API key uses, which `AuthStorage` can
 * write but has no matching call to clear.
 */

import type { AuthStorage } from "@mastra/code-sdk/auth/storage";
import type { OAuthCredentials } from "@mastra/code-sdk/auth/types";

import { PROVIDERS, PROVIDER_IDS, getAuthProviderId, type ProviderId } from "./providers.ts";

/**
 * The prefix `AuthStorage` files pasted API keys under.
 *
 * Its own documentation states the format ("Keys are stored under
 * `apikey:<provider>`") and `setStoredApiKey` / `getStoredApiKey` both use it.
 * We need it because there is a setter and a getter but no remover, and
 * disconnecting has to clear both slots or a "disconnected" provider keeps
 * working from the one we left behind.
 */
const API_KEY_SLOT_PREFIX = "apikey:";

/** How a provider came to be connected. */
export type ConnectionMethod = "oauth" | "api-key";

/**
 * What the settings page is told about a provider. Deliberately not a
 * credential: whether, and how, and until when — never the secret itself.
 */
export interface ProviderConnection {
  provider: ProviderId;
  name: string;
  connected: boolean;
  method?: ConnectionMethod;
  /** ms epoch the OAuth token expires; absent for API keys, which do not. */
  expiresAt?: number;
}

export interface CredentialStore {
  connectOAuth(provider: ProviderId, credentials: OAuthCredentials): void;
  connectApiKey(provider: ProviderId, key: string): void;
  disconnect(provider: ProviderId): void;
  status(provider: ProviderId): ProviderConnection;
  statuses(): ProviderConnection[];
}

/**
 * The read surface this module needs from `AuthStorage`. Stated separately so a
 * test can supply a store without a real `auth.json`, and so tenant mode can
 * later supply a per-user one, which is the whole reason the SDK made
 * `CredentialStore` structural in the first place.
 */
export type CredentialBackingStore = Pick<
  AuthStorage,
  "get" | "set" | "remove" | "has" | "setStoredApiKey" | "getStoredApiKey"
>;

export class AuthStorageCredentialStore implements CredentialStore {
  private readonly storage: CredentialBackingStore;

  constructor(storage: CredentialBackingStore) {
    this.storage = storage;
  }

  connectOAuth(provider: ProviderId, credentials: OAuthCredentials): void {
    this.storage.set(getAuthProviderId(provider), { type: "oauth", ...credentials });
  }

  connectApiKey(provider: ProviderId, key: string): void {
    // The env var goes with it: `setStoredApiKey` sets it so model resolution
    // finds the key in this process without a restart.
    this.storage.setStoredApiKey(
      getAuthProviderId(provider),
      key,
      PROVIDERS[provider].apiKeyEnvVar,
    );
  }

  disconnect(provider: ProviderId): void {
    const authProviderId = getAuthProviderId(provider);
    const storedKey = this.storage.getStoredApiKey(authProviderId);

    this.storage.remove(authProviderId);
    this.storage.remove(`${API_KEY_SLOT_PREFIX}${authProviderId}`);

    // `setStoredApiKey` reached into the environment on the way in, so
    // disconnecting has to reach back in on the way out — but only for the
    // value it put there. An operator who exported their own key before
    // starting the process did not ask us to unset it, and a disconnect that
    // silently emptied their environment would be a worse surprise than the
    // one it was trying to prevent.
    const envVar = PROVIDERS[provider].apiKeyEnvVar;
    if (storedKey !== undefined && process.env[envVar] === storedKey) {
      delete process.env[envVar];
    }
  }

  status(provider: ProviderId): ProviderConnection {
    const descriptor = PROVIDERS[provider];
    const credential = this.storage.get(descriptor.authProviderId);

    if (credential?.type === "oauth") {
      return {
        provider,
        name: descriptor.name,
        connected: true,
        method: "oauth",
        expiresAt: credential.expires,
      };
    }

    // Either slot counts: the gateway reads the main slot first and falls back
    // to the `apikey:` one, so a key in either means this provider works.
    const hasKey =
      (credential?.type === "api_key" && credential.key.trim().length > 0) ||
      (this.storage.getStoredApiKey(descriptor.authProviderId)?.trim().length ?? 0) > 0;

    if (hasKey) {
      return { provider, name: descriptor.name, connected: true, method: "api-key" };
    }

    return { provider, name: descriptor.name, connected: false };
  }

  statuses(): ProviderConnection[] {
    return PROVIDER_IDS.map((provider) => this.status(provider));
  }
}
