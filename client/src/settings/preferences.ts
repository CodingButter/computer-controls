/**
 * The settings a person chose, kept where a restart can still find them.
 *
 * Everything the hub reads about itself today comes from the environment, which
 * is the right shape for a deployer and the wrong shape for a person: an
 * environment variable is not something you can change by saying so. A spoken
 * "use OpenAI for the voice" that only lasted until the process exited would be
 * a setting in the way a sticky note is a filing cabinet.
 *
 * So there is a file. It holds choices, never credentials — the credential store
 * is `auth.json` and stays the only thing that knows a secret. It lives beside
 * the hub's own config rather than in the SDK's `settings.json`, because that
 * file belongs to the agent runtime and gets rewritten by it.
 *
 * Malformed content raises rather than resetting to defaults. A preference file
 * that silently empties itself is how a person ends up re-picking the same
 * setting every week without ever learning why it keeps moving.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseVoiceProviderId, type VoiceProviderId } from "../voice/providers.ts";

/** The hub's own settings file, beside the runtime's rather than inside it. */
export const HUB_PREFERENCES_FILE = "hub-settings.json";

/** What a person has picked. Absent keys mean "no choice made", not "off". */
export interface HubPreferences {
  voiceProvider?: VoiceProviderId;
}

/** The read/write surface the settings service needs. Structural so a test can supply memory. */
export interface PreferenceStore {
  read(): HubPreferences;
  saveVoiceProvider(provider: VoiceProviderId): HubPreferences;
}

/**
 * Narrow an untrusted file body to preferences we recognise.
 *
 * An unreadable value for a known key is dropped rather than raising: the file
 * parsed, so nothing is corrupt, and a stale provider name should cost a person
 * their preferred voice rather than their hub. Unparseable JSON is the other
 * case entirely, and `read` raises on it.
 */
function parsePreferences(body: unknown): HubPreferences {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const voiceProvider = parseVoiceProviderId((body as Record<string, unknown>).voiceProvider);
  return voiceProvider ? { voiceProvider } : {};
}

export class FilePreferenceStore implements PreferenceStore {
  private readonly file: string;

  /** @param dir The hub's config directory — `<root>/.mastracode` in local mode. */
  constructor(dir: string) {
    this.file = path.join(dir, HUB_PREFERENCES_FILE);
  }

  read(): HubPreferences {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      // No file is the honest state of a hub nobody has configured yet.
      return {};
    }

    try {
      return parsePreferences(JSON.parse(raw));
    } catch (error) {
      throw new Error(
        `${this.file} is not valid JSON, so the settings you chose cannot be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  saveVoiceProvider(provider: VoiceProviderId): HubPreferences {
    const next: HubPreferences = { ...this.read(), voiceProvider: provider };
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }
}

/** A store with no file behind it, for tests and for a hub told not to persist. */
export class MemoryPreferenceStore implements PreferenceStore {
  private preferences: HubPreferences;

  constructor(initial: HubPreferences = {}) {
    this.preferences = { ...initial };
  }

  read(): HubPreferences {
    return { ...this.preferences };
  }

  saveVoiceProvider(provider: VoiceProviderId): HubPreferences {
    this.preferences = { ...this.preferences, voiceProvider: provider };
    return this.read();
  }
}
