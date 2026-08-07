/**
 * The settings service with the confirm rule wired in.
 *
 * The service knows how to change things. The store knows how to hold a change
 * until somebody says yes. Neither of them enforces that the second happens
 * before the first — this does, and it is the only object the config agent's
 * tools are given, so there is no path from a tool to a widening change that
 * skips it.
 *
 * The asymmetry is deliberate and worth stating once. Widening stages and waits.
 * Narrowing happens. A person who says "disconnect everything" is not somebody
 * to slow down, and the injected-text worry runs the other way for narrowing:
 * the worst a hostile page achieves is turning something off, which is the
 * state the machine is safe in.
 */

import { HUB_TURNS, type TurnScope } from "../turn.ts";
import type { ProviderId } from "../auth/providers.ts";
import type { LoginSessionView } from "../auth/service.ts";
import type { ProviderConnection } from "../auth/credentials.ts";
import type { VoiceProviderId } from "../voice/providers.ts";
import type { SettingsAudit, SettingsSurface } from "./audit.ts";
import { ConfirmationStore, type ConfirmationRequest } from "./confirm.ts";
import {
  SETTINGS_CHANGE_DIRECTION,
  SettingsError,
  type SettingsChange,
  type SettingsService,
  type VoiceSettingView,
} from "./service.ts";

/** A change that is waiting on a person, rather than a change that happened. */
export interface PendingResult {
  status: "needs-confirmation";
  token: string;
  /** Say this, exactly, and wait for an answer. */
  echo: string;
}

/** A change that happened. */
export interface AppliedResult<T> {
  status: "applied";
  /** What to tell the person, in the past tense, because it is done. */
  summary: string;
  result: T;
}

export type ChangeResult<T> = PendingResult | AppliedResult<T>;

export interface SettingsGateOptions {
  settings: SettingsService;
  audit: SettingsAudit;
  confirmations?: ConfirmationStore;
  /**
   * Where the gate learns which turn it is being asked in. The hub's own scope
   * unless a test supplies another, and the same scope the chat entry point
   * opens turns on — a gate reading a scope nobody writes has no turns to tell
   * apart, which is why it refuses to work outside one at all.
   */
  turns?: TurnScope;
}

export class SettingsGate {
  private readonly settings: SettingsService;
  private readonly audit: SettingsAudit;
  private readonly confirmations: ConfirmationStore;
  private readonly turns: TurnScope;

  constructor(options: SettingsGateOptions) {
    this.settings = options.settings;
    this.audit = options.audit;
    this.confirmations = options.confirmations ?? new ConfirmationStore();
    this.turns = options.turns ?? HUB_TURNS;
  }

  /** Reads pass straight through: knowing what the settings are changes nothing. */
  listVoiceProviders(): VoiceSettingView[] {
    return this.settings.listVoiceProviders();
  }

  listAccounts() {
    return this.settings.listAccounts();
  }

  /**
   * Ask for a widening change.
   *
   * Nothing is validated here beyond the shape — a provider with no credential
   * is refused by the service at commit time, so a person hears the refusal
   * after saying yes rather than instead of being asked. That is the wrong order
   * for a conversation, so the service is asked to check first, without writing.
   */
  requestVoiceProvider(provider: VoiceProviderId): PendingResult {
    this.assertVoiceProviderIsPickable(provider);
    return this.pend("selectVoiceProvider", provider);
  }

  requestAccountConnect(provider: ProviderId): PendingResult {
    return this.pend("startAccountConnect", provider);
  }

  /**
   * Narrowing. No handle, no waiting — and still audited, because "who turned
   * this off" is as much of a question as "who turned it on".
   */
  disconnectAccount(provider: ProviderId, surface: SettingsSurface): AppliedResult<ProviderConnection> {
    const result = this.settings.disconnectAccount(provider);
    this.audit.record({
      at: new Date().toISOString(),
      change: "disconnectAccount",
      target: provider,
      surface,
      authorised: "narrowing",
    });
    return { status: "applied", summary: `Disconnected ${result.name}.`, result };
  }

  /**
   * Spend a person's yes and make the change they confirmed.
   *
   * The change is read from the store, not from the caller: a confirmation that
   * carried its own description of what it was confirming would let the sentence
   * a person heard and the change that lands drift apart, which is the only
   * thing this whole mechanism exists to prevent.
   *
   * The turn is read here rather than taken as an argument for the same reason:
   * a caller that could name its own turn could name the one it was not in.
   */
  async confirm(
    token: string,
    ownerId: string,
    surface: SettingsSurface,
  ): Promise<AppliedResult<VoiceSettingView[] | LoginSessionView>> {
    const staged = this.confirmations.commit(token, this.currentTurn());

    const applied = await this.apply(staged.change, staged.target, ownerId);

    this.audit.record({
      at: new Date().toISOString(),
      change: staged.change,
      target: staged.target,
      surface,
      authorised: "explicit-yes",
      echo: staged.echo,
    });
    return applied;
  }

  /** Drop a staged change. What "no" does, and it is not audited: nothing happened. */
  decline(token: string): boolean {
    return this.confirmations.discard(token);
  }

  /** Waiting changes, for a test and for the health surface. Never the tokens. */
  get pendingCount(): number {
    return this.confirmations.size;
  }

  private pend(change: SettingsChange, target: string): PendingResult {
    if (SETTINGS_CHANGE_DIRECTION[change] !== "widen") {
      throw new SettingsError(500, "Only a widening change is staged for confirmation.");
    }
    const request: ConfirmationRequest = this.confirmations.stage(change, target, this.currentTurn());
    return { status: "needs-confirmation", token: request.token, echo: request.echo };
  }

  /**
   * The turn this call is part of, or a refusal.
   *
   * Refusing is the whole point of reading it here. If a widening change could
   * be staged with no turn recorded, a yes could not be told apart from the
   * request that produced it, and the check would quietly pass for exactly the
   * caller it exists to catch. A gate that is wired wrong has to stop working
   * rather than stop checking, so both halves — asking and confirming — insist
   * on a turn, and anything that wants to use this gate from somewhere other
   * than a conversation has to say what its turn is first.
   */
  private currentTurn(): string {
    const turn = this.turns.current();
    if (!turn) {
      throw new SettingsError(
        500,
        "A settings change has to happen inside a turn, and this one did not. Nothing was changed.",
      );
    }
    return turn;
  }

  private assertVoiceProviderIsPickable(provider: VoiceProviderId): void {
    const offered = this.settings.listVoiceProviders();
    if (!offered.some((view) => view.provider === provider)) {
      throw new SettingsError(
        400,
        `There is no ${provider} credential on this machine, so picking it would not give you a voice.`,
      );
    }
  }

  private async apply(
    change: SettingsChange,
    target: string,
    ownerId: string,
  ): Promise<AppliedResult<VoiceSettingView[] | LoginSessionView>> {
    switch (change) {
      case "selectVoiceProvider": {
        const result = this.settings.selectVoiceProvider(target as VoiceProviderId);
        return {
          status: "applied",
          summary: `The voice will use ${target} from the next start.`,
          result,
        };
      }
      case "startAccountConnect": {
        const result = await this.settings.startAccountConnect(ownerId, target as ProviderId);
        return {
          status: "applied",
          summary: result.userCode
            ? `Go to ${result.url} and enter the code ${result.userCode}.`
            : `Go to ${result.url} to finish signing in.`,
          result,
        };
      }
      case "disconnectAccount":
        // Narrowing never reaches here: it is applied directly and never staged.
        throw new SettingsError(500, "A narrowing change does not go through confirmation.");
    }
  }
}
