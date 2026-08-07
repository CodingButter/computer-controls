/**
 * The packs a person made, and the one they picked, kept where a restart can
 * still find them.
 *
 * A file rather than an environment variable, for the reason `../settings/
 * preferences.ts` gives: a variable is not something you can change by saying
 * so. It sits beside the hub's own config under the hub's root, not in the
 * runtime's `settings.json`, because that file belongs to the agent runtime and
 * gets rewritten by it.
 *
 * It holds names of models and nothing else — no key, no token, no provider
 * credential. Those live in `auth.json` and stay the only thing on this machine
 * that knows a secret.
 *
 * Malformed content is refused rather than reset. A file that silently empties
 * itself is how a person loses a pack they built and never learns why.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { BrainTier } from "../../../clients/mastra-plugin/src/scope-brain.ts";
import { TIERS } from "../model-pack.ts";

/** The hub's pack file, beside the runtime's settings rather than inside it. */
export const MODEL_PACKS_FILE = "model-packs.json";

/** A pack a person built here: a name they chose and one model per tier. */
export interface CustomPack {
  id: string;
  name: string;
  models: Record<BrainTier, string>;
}

/** What the file says, once it has been read. Absent keys mean "nothing chosen". */
export interface PackDocument {
  activeId?: string;
  custom: readonly CustomPack[];
}

/**
 * A file that exists but cannot be read as pack configuration.
 *
 * Its own class because the callers have to tell it apart from "no file yet":
 * absence is a hub nobody has configured, which is fine and resolves to the
 * declared pack, whereas this has to stop a write before it happens and reach
 * the page as a reason.
 */
export class MalformedPackFile extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "MalformedPackFile";
  }
}

export interface PackStore {
  read(): PackDocument;
  write(next: PackDocument): PackDocument;
}

function parsePack(value: unknown, file: string): CustomPack {
  const row = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const models =
    typeof row.models === "object" && row.models !== null
      ? (row.models as Record<string, unknown>)
      : {};
  if (!id || !name) {
    throw new MalformedPackFile(`${file} holds a pack with no id or no name.`);
  }
  const resolved = {} as Record<BrainTier, string>;
  for (const tier of TIERS) {
    const model = models[tier];
    if (typeof model !== "string" || !model.trim()) {
      throw new MalformedPackFile(`${file}: the pack "${name}" names no model for "${tier}".`);
    }
    resolved[tier] = model.trim();
  }
  return { id, name, models: resolved };
}

export class FilePackStore implements PackStore {
  private readonly file: string;

  /** @param dir The hub's config directory — `<root>/.mastracode` in local mode. */
  constructor(dir: string) {
    this.file = path.join(dir, MODEL_PACKS_FILE);
  }

  read(): PackDocument {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      // No file is the honest state of a hub nobody has configured yet: the
      // build's declared pack answers, exactly as it did before this route.
      return { custom: [] };
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (error) {
      throw new MalformedPackFile(
        `${this.file} is not valid JSON, so the packs you made cannot be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new MalformedPackFile(`${this.file} must contain a JSON object.`);
    }

    const document = body as Record<string, unknown>;
    const custom = Array.isArray(document.custom)
      ? document.custom.map((entry) => parsePack(entry, this.file))
      : [];
    const activeId = typeof document.activeId === "string" ? document.activeId.trim() : "";
    return { custom, ...(activeId ? { activeId } : {}) };
  }

  /**
   * Rewrite the file, keeping every key this hub does not own.
   *
   * Temp file then rename, which is atomic within a directory on POSIX: a reader
   * arriving mid-write sees the old file or the new one, never half of either.
   * Unknown keys are read back and carried across, so a key some later version
   * of this hub writes is not deleted by an older one that never heard of it.
   */
  write(next: PackDocument): PackDocument {
    let existing: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Absent or unreadable: `read` already refused the unreadable case before
      // any caller got as far as a write, so this is the empty-file path.
    }

    const document = {
      ...existing,
      custom: next.custom,
      ...(next.activeId ? { activeId: next.activeId } : {}),
    };
    if (!next.activeId) delete document.activeId;

    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.file);
    return next;
  }
}

/** A store with no file behind it, for tests and for a hub told not to persist. */
export class MemoryPackStore implements PackStore {
  private document: PackDocument;

  constructor(initial: PackDocument = { custom: [] }) {
    this.document = initial;
  }

  read(): PackDocument {
    return { custom: [...this.document.custom], ...(this.document.activeId ? { activeId: this.document.activeId } : {}) };
  }

  write(next: PackDocument): PackDocument {
    this.document = next;
    return this.read();
  }
}
