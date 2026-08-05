import fs from "node:fs";
import path from "node:path";

import type { DesktopEntryApp } from "../permissions/desktop-entries.ts";
import type { PermissionRow } from "../permissions/registry.ts";

/**
 * Curing: teaching a Chromium-based launcher to expose its accessibility tree.
 *
 * Chromium builds their renderer's accessibility tree only when something asks
 * for it. On a Linux desktop the usual asker is a screen reader announcing
 * itself on the accessibility bus, and this project refuses to be one — writing
 * `ScreenReaderEnabled` would be telling every application on the machine that
 * a blind user is present, which is both a lie and a fact about a person we
 * have no business broadcasting. The honest lever is the launch flag: an app
 * started with `--force-renderer-accessibility` builds the tree for itself.
 *
 * So curing edits launchers, not the bus. It writes a user-scope copy of the
 * .desktop file into ~/.local/share/applications with the flag added to every
 * Exec line, which freedesktop precedence makes win over the system copy. The
 * system copy is never touched: it belongs to the package manager, and an
 * upgrade that reverted our edit would be the least confusing outcome of
 * writing there.
 *
 * Two limits are deliberate. Only PERMITTED applications are cured — curing an
 * application the user has not permitted would prepare a readable tree for
 * something the ceiling withholds anyway, which is work done for a permission
 * nobody granted. And nothing here restarts anything: a cured launcher takes
 * effect the next time the person starts the app, so the report says which
 * applications are waiting on that rather than closing their windows for them.
 */

export const ACCESSIBILITY_FLAG = "--force-renderer-accessibility";

/**
 * Binaries whose renderers are Chromium's, by basename.
 *
 * A name list rather than a probe, and a conservative one. A false negative
 * costs an application that stays unreadable until someone adds a name here,
 * and the permissions page already shows that state plainly. A false positive
 * passes an unknown flag to something that will most likely ignore it — cheap,
 * but it is churn in a file the user owns, so the list stays short and known.
 */
export const CHROMIUM_BINARIES: readonly string[] = [
  "brave",
  "brave-browser",
  "chrome",
  "chromium",
  "chromium-browser",
  "code",
  "code-insiders",
  "discord",
  "electron",
  "google-chrome",
  "google-chrome-stable",
  "microsoft-edge",
  "msedge",
  "obsidian",
  "opera",
  "signal-desktop",
  "slack",
  "spotify",
  "vivaldi",
];

/** Wrappers that launch something else; the interesting token is the next one. */
const WRAPPERS = new Set(["env", "sh", "bash", "exec", "nohup", "setsid"]);

/** Split an Exec value into tokens, honouring the quoting the spec allows. */
function tokenize(exec: string): string[] {
  return exec.match(/"[^"]*"|\S+/g) ?? [];
}

function basenameOf(token: string): string {
  const unquoted = token.replace(/^"|"$/g, "");
  return path.basename(unquoted).toLowerCase().replace(/\.exe$/, "");
}

/**
 * Whether this Exec line starts a Chromium-family application.
 *
 * The first token is the program, except when it is a wrapper, in which case
 * the program is the first token after it that is not an assignment — `env
 * FOO=bar discord` really does start Discord.
 */
export function isChromiumExec(exec: string): boolean {
  for (const token of tokenize(exec)) {
    if (token.startsWith("-")) continue;
    if (token.includes("=") && !token.includes("/")) continue;
    const name = basenameOf(token);
    if (WRAPPERS.has(name)) continue;
    return CHROMIUM_BINARIES.includes(name);
  }
  return false;
}

/** Whether the flag is already on this line — the test that makes curing idempotent. */
export function isCured(exec: string): boolean {
  return tokenize(exec).some((token) => token.replace(/^"|"$/g, "") === ACCESSIBILITY_FLAG);
}

/**
 * The same Exec line with the flag added directly after the program.
 *
 * After the program rather than at the end because the end is where the field
 * codes live (`%U`, `%F`): the desktop file's launcher substitutes real
 * arguments there, and a flag after them would arrive after the URL it was
 * meant to precede.
 */
export function cureExecLine(exec: string): string {
  if (isCured(exec)) return exec;
  const tokens = tokenize(exec);
  if (tokens.length === 0) return exec;
  let insertAt = 1;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token.startsWith("-")) continue;
    if (token.includes("=") && !token.includes("/")) continue;
    if (WRAPPERS.has(basenameOf(token))) continue;
    insertAt = i + 1;
    break;
  }
  return [...tokens.slice(0, insertAt), ACCESSIBILITY_FLAG, ...tokens.slice(insertAt)].join(" ");
}

/** The whole desktop file with every Exec line cured — actions included. */
export function cureDesktopFile(text: string): { text: string; changed: boolean } {
  let changed = false;
  const lines = text.split("\n").map((line) => {
    const match = /^(\s*Exec\s*=)(.*)$/.exec(line);
    if (!match) return line;
    const value = match[2] as string;
    if (!isChromiumExec(value) || isCured(value)) return line;
    changed = true;
    return `${match[1] as string}${cureExecLine(value)}`;
  });
  return { text: lines.join("\n"), changed };
}

export type CuredApp = { name: string; desktopId: string };

export type CureReport = {
  /** Launchers rewritten by this run. */
  cured: CuredApp[];
  /** Chromium launchers that already carried the flag. Nothing was written. */
  alreadyCured: CuredApp[];
  /**
   * Applications that are running right now and were cured or already cured —
   * the flag reaches a process at launch, so these need the person to restart
   * them. The hub says which; it never closes a window it did not open.
   */
  needsRestart: string[];
};

export type CureDeps = {
  /** The merged permission rows: only the permitted ones are candidates. */
  rows: PermissionRow[];
  /** The scanned launcher entries, carrying the source file each was read from. */
  entries: DesktopEntryApp[];
  /** Where overrides are written. The system directory is never a candidate. */
  userApplicationsDir: string;
};

/**
 * Cure every permitted Chromium launcher, and report what a person still has
 * to do about it.
 */
export function cureChromiumApps(deps: CureDeps): CureReport {
  const report: CureReport = { cured: [], alreadyCured: [], needsRestart: [] };
  const byDesktopId = new Map(deps.entries.map((entry) => [entry.desktopId, entry]));

  for (const row of deps.rows) {
    if (!row.permitted || !row.desktopId) continue;
    const entry = byDesktopId.get(row.desktopId);
    if (!entry?.sourcePath || !entry.exec) continue;
    if (!isChromiumExec(entry.exec)) continue;

    let source: string;
    try {
      source = fs.readFileSync(entry.sourcePath, "utf8");
    } catch {
      continue; // A launcher that vanished between scan and cure is not an error.
    }

    const target = path.join(deps.userApplicationsDir, row.desktopId);
    const cured = cureDesktopFile(source);
    const record = { name: row.name, desktopId: row.desktopId };

    if (!cured.changed) {
      // Every Exec line already carries the flag — in the override we wrote
      // last boot, or in the packaged file itself. Writing again would be
      // churn in a file the user owns, so this run leaves it alone.
      report.alreadyCured.push(record);
      // Still running from before the cure: readable is the proof it took.
      if (row.running && !row.readable) report.needsRestart.push(row.name);
      continue;
    }

    try {
      fs.mkdirSync(deps.userApplicationsDir, { recursive: true });
      fs.writeFileSync(target, cured.text, "utf8");
    } catch {
      continue;
    }
    report.cured.push(record);
    if (row.running) report.needsRestart.push(row.name);
  }

  return report;
}
