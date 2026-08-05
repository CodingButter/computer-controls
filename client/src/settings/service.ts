/**
 * Everything the dashboard can change, behind one door.
 *
 * The settings pages already know how to change these things; each one calls a
 * store or a service directly and renders the answer. That works for a page,
 * where a human's click is the authorisation, and it does not work for an agent,
 * where the request arrives as text and text is the one thing a hostile web page
 * can also produce. Putting the operations here gives the config agent something
 * to hold that is smaller than "the hub": a fixed list of settings verbs, none
 * of which touch the desktop, the workspace, or a credential's value.
 *
 * Two rules are enforced here rather than left to callers.
 *
 * A change is either widening or narrowing, and the service says which. Turning
 * a voice on, connecting an account — those add capability, and Phase two's
 * confirm gate makes them wait for a person's explicit yes. Disconnecting takes
 * capability away, and a person who asks for that should not have to argue with
 * a confirmation prompt to get it.
 *
 * No secret leaves this module. The account operations here are the flow
 * drivers, not the credential ones: a login can be started and polled, which
 * yields a URL and a short code a person types themselves, and it can be torn
 * down. Pasting an API key stays on the page, where the key travels from a human
 * to the server without an agent in the middle repeating it.
 */

import type { ProviderConnection } from "../auth/credentials.ts";
import { PROVIDERS, type ProviderId } from "../auth/providers.ts";
import type { LoginSessionView, ProviderFlowView, ProviderLoginService } from "../auth/service.ts";
import {
  VOICE_PROVIDERS,
  hasVoiceCredential,
  listVoiceProviders,
  type VoiceCredentialLookup,
  type VoiceProviderId,
  type VoiceProviderView,
} from "../voice/providers.ts";
import type { PreferenceStore } from "./preferences.ts";

/**
 * Which direction a settings change moves the boundary.
 *
 * The word is the whole point: `widen` is what has to wait for a yes.
 */
export type ChangeDirection = "widen" | "narrow";

/** A settings refusal, carried far enough to become a response or a spoken sentence. */
export class SettingsError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SettingsError";
    this.status = status;
  }
}

/** A voice provider as the settings surface sees it, plus whether it is the one in use. */
export interface VoiceSettingView extends VoiceProviderView {
  selected: boolean;
}

/** Asking whether a voice credential exists — never what it is. */
export type VoiceCredentialPresence = Pick<VoiceCredentialLookup, "get" | "getStoredApiKey">;

export interface SettingsServiceOptions {
  /**
   * The `auth.json` store itself, for asking whether a voice credential exists.
   * Presence only — this is the same read surface `voice/providers.ts` takes,
   * and it is deliberately not the write surface.
   */
  voiceCredentials: VoiceCredentialPresence;
  /** The existing sign-in service; the settings service drives flows, never credentials. */
  login: ProviderLoginService;
  preferences: PreferenceStore;
}

export class SettingsService {
  private readonly voiceCredentials: VoiceCredentialPresence;
  private readonly login: ProviderLoginService;
  private readonly preferences: PreferenceStore;

  constructor(options: SettingsServiceOptions) {
    this.voiceCredentials = options.voiceCredentials;
    this.login = options.login;
    this.preferences = options.preferences;
  }

  /**
   * The mouths this machine can offer, and which one is picked.
   *
   * Read per call rather than captured: connecting an account has to change this
   * answer without a restart, which is the same reason the voice route asks for
   * the list per request.
   */
  listVoiceProviders(): VoiceSettingView[] {
    const selected = this.preferences.read().voiceProvider;
    return listVoiceProviders(this.voiceCredentials).map((view) => ({
      ...view,
      selected: view.provider === selected,
    }));
  }

  /**
   * Pick a mouth.
   *
   * Widening: it turns something on. A provider with no credential is refused
   * here rather than saved and discovered broken at the next start, because the
   * person asking is having a conversation and can be told why now.
   */
  selectVoiceProvider(provider: VoiceProviderId): VoiceSettingView[] {
    const descriptor = VOICE_PROVIDERS[provider];
    if (!hasVoiceCredential(this.voiceCredentials, provider)) {
      throw new SettingsError(400, descriptor.missingCredentialReason);
    }
    this.preferences.saveVoiceProvider(provider);
    return this.listVoiceProviders();
  }

  /** Every account, how it signs in, and whether it currently is. Never a token. */
  listAccounts(): ProviderFlowView[] {
    return this.login.listFlows();
  }

  /**
   * Begin a sign-in, and hand back what a person has to do next.
   *
   * Widening. What comes back is a URL and, for the device flow, a short code —
   * both meant to be read out loud. The credential arrives later, directly from
   * the provider to the store, and never passes through this return value.
   */
  async startAccountConnect(ownerId: string, provider: ProviderId): Promise<LoginSessionView> {
    return await this.login.startLogin(ownerId, provider);
  }

  /** Ask once whether the person has finished approving a device flow. */
  async pollAccountConnect(ownerId: string, sessionId: string): Promise<LoginSessionView> {
    return await this.login.pollLogin(ownerId, sessionId);
  }

  /**
   * Sign an account out.
   *
   * Narrowing, and therefore immediate. Someone saying "disconnect OpenAI" is
   * closing a door, and a hub that made them confirm it twice would be teaching
   * them to say yes reflexively, which is the habit the confirm gate exists to
   * avoid relying on.
   */
  disconnectAccount(provider: ProviderId): ProviderConnection {
    return this.login.disconnect(provider);
  }
}

/**
 * Which way a settings verb moves the boundary.
 *
 * Stated as data beside the service rather than inferred at the call site, so
 * the confirm gate and the audit record agree about what happened, and so
 * adding a verb without classifying it is a type error rather than a silent
 * pass through the gate.
 */
export const SETTINGS_CHANGE_DIRECTION = {
  selectVoiceProvider: "widen",
  startAccountConnect: "widen",
  disconnectAccount: "narrow",
} as const satisfies Record<string, ChangeDirection>;

/** A settings verb that changes something, as opposed to the read-only ones. */
export type SettingsChange = keyof typeof SETTINGS_CHANGE_DIRECTION;

/**
 * How a pending change reads back to the person who asked for it.
 *
 * The echo is the confirmable artefact: what a person hears before saying yes
 * has to name the exact change, or the yes is not about anything in particular.
 */
export function describeChange(change: SettingsChange, target: string): string {
  switch (change) {
    case "selectVoiceProvider":
      return `use ${VOICE_PROVIDERS[target as VoiceProviderId]?.name ?? target} for the voice`;
    case "startAccountConnect":
      return `start signing in to ${PROVIDERS[target as ProviderId]?.name ?? target}`;
    case "disconnectAccount":
      return `disconnect ${PROVIDERS[target as ProviderId]?.name ?? target}`;
  }
}
