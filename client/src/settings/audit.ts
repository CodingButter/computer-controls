/**
 * Who opened this door.
 *
 * The daemon keeps an audit of what it did to the desktop. Nothing above it
 * keeps one, which was fine while every settings change was a person clicking a
 * button in front of them — the click was the record, and they were there for
 * it. A change that can be made by talking needs its own answer to "when did
 * this get turned on, and what made that happen", because the person asking may
 * be the same person who said the sentence, three weeks later, having forgotten.
 *
 * One line per change, appended, never rewritten. It records the shape of the
 * arc — what changed, which surface asked, and the sentence that was confirmed —
 * and it records nothing a credential could be reconstructed from, because the
 * settings service never had one to leak.
 *
 * A change that was refused, or staged and never confirmed, writes nothing. The
 * file is a record of what happened to this machine, not of what was suggested
 * to it; a log that filled up with every request an injected page made would
 * bury the three lines that mattered.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { SettingsChange } from "./service.ts";

/** Where the record lives, beside the hub's other state. */
export const SETTINGS_AUDIT_FILE = "settings-audit.jsonl";

/**
 * Which door the change came through.
 *
 * Not "voice" and "chat": those are the same door. A spoken turn and a typed
 * one arrive as the same turn on the same thread with the same history, which
 * is deliberate — it is what makes "do that again" work across both — and a
 * record that claimed to tell them apart would be inventing the difference.
 *
 * The distinction that is real, and the one somebody reading this file later
 * actually wants, is whether a person asked for the change in words or clicked
 * it themselves.
 */
export type SettingsSurface = "conversation" | "settings-page";

export interface SettingsAuditEntry {
  /** ISO 8601, because this file is read by people at least as often as by code. */
  at: string;
  change: SettingsChange;
  target: string;
  surface: SettingsSurface;
  /**
   * How the change was authorised. `explicit-yes` is a person answering the
   * echoed sentence; `narrowing` is a change that took capability away and did
   * not need one.
   */
  authorised: "explicit-yes" | "narrowing";
  /** The exact sentence a person said yes to. Absent for narrowing changes. */
  echo?: string;
}

export interface SettingsAudit {
  record(entry: SettingsAuditEntry): void;
  /** What has been recorded, newest last. */
  entries(): SettingsAuditEntry[];
}

export class FileSettingsAudit implements SettingsAudit {
  private readonly file: string;

  /** @param dir The hub's config directory — `<root>/.mastracode` in local mode. */
  constructor(dir: string) {
    this.file = path.join(dir, SETTINGS_AUDIT_FILE);
  }

  record(entry: SettingsAuditEntry): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
  }

  entries(): SettingsAuditEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SettingsAuditEntry);
  }
}

/** An audit with no file behind it, for tests. */
export class MemorySettingsAudit implements SettingsAudit {
  private readonly log: SettingsAuditEntry[] = [];

  record(entry: SettingsAuditEntry): void {
    this.log.push(entry);
  }

  entries(): SettingsAuditEntry[] {
    return [...this.log];
  }
}
