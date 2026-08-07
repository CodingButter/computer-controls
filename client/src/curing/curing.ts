import fs from "node:fs";
import path from "node:path";

import type { DesktopEntry } from "../platform/freedesktop/entries.ts";
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
export function execProgram(exec: string): string | undefined {
  for (const token of tokenize(exec)) {
    if (token.startsWith("-")) continue;
    if (token.includes("=") && !token.includes("/")) continue;
    const name = basenameOf(token);
    if (WRAPPERS.has(name)) continue;
    return name;
  }
  return undefined;
}

export function isChromiumExec(exec: string): boolean {
  const program = execProgram(exec);
  return program !== undefined && CHROMIUM_BINARIES.includes(program);
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

/**
 * The whole desktop file with every Exec line cured — actions included.
 *
 * `chromium` is reported alongside `changed` because the two absences mean
 * opposite things: a file nothing here recognises is not a candidate at all,
 * while a Chromium file that changed nothing is one that already carries the
 * flag. The file itself is the only place that distinction can be read, which
 * is why the caller does not need an `Exec` field handed to it separately.
 */
export function cureDesktopFile(text: string): {
  text: string;
  changed: boolean;
  chromium: boolean;
} {
  let changed = false;
  let chromium = false;
  const lines = text.split("\n").map((line) => {
    const match = /^(\s*Exec\s*=)(.*)$/.exec(line);
    if (!match) return line;
    const value = match[2] as string;
    if (!isChromiumExec(value)) return line;
    chromium = true;
    if (isCured(value)) return line;
    changed = true;
    return `${match[1] as string}${cureExecLine(value)}`;
  });
  return { text: lines.join("\n"), changed, chromium };
}

export type CuredApp = {
  name: string;
  desktopId: string;
  /**
   * Every launcher file this application was cured through. An application
   * reachable from the menu, an autostart entry and a desktop icon is one
   * application with three ways in, and all three have to carry the flag —
   * the one we missed is the launch that arrives unreadable.
   */
  launchers: string[];
};

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
  entries: DesktopEntry[];
  /** Where overrides are written. The system directory is never a candidate. */
  userApplicationsDir: string;
  /**
   * Directories whose launchers are cured *in place* — autostart entries and
   * desktop icons.
   *
   * These get different treatment from application launchers on purpose. An
   * application launcher is cured by writing a same-named override into the
   * user's data directory, because freedesktop's precedence rule makes that
   * override win. No such rule exists here: the session manager reads exactly
   * the file in `~/.config/autostart`, and the file manager launches exactly
   * the icon on the desktop. There is nowhere to shadow them from, so the file
   * itself is rewritten — and only ever a file that already exists, belonging
   * to an application the user has already permitted.
   */
  inPlaceDirs?: string[];
};

/**
 * Cure every permitted Chromium launcher, and report what a person still has
 * to do about it.
 */
export function cureChromiumApps(deps: CureDeps): CureReport {
  const byId = new Map(deps.entries.map((entry) => [entry.id, entry]));

  // One application can own several launchers, so what happened to it is
  // accumulated before anything is reported: an application cured in two
  // places is one line in the report, not two.
  type State = { name: string; desktopId: string; wrote: string[]; found: string[] };
  const states = new Map<string, State>();
  // What each permitted application's own launcher starts, learned from the
  // files this loop already reads, so an autostart entry can be recognised by
  // what it runs rather than by what it is called.
  const programs = new Map<string, PermissionRow>();
  const stateFor = (row: PermissionRow, desktopId: string): State => {
    let state = states.get(desktopId);
    if (!state) {
      state = { name: row.name, desktopId, wrote: [], found: [] };
      states.set(desktopId, state);
    }
    return state;
  };

  for (const row of deps.rows) {
    if (!row.permitted || !row.desktopId) continue;
    const entry = byId.get(row.desktopId);
    if (!entry) continue;

    let source: string;
    try {
      source = fs.readFileSync(entry.source, "utf8");
    } catch {
      continue; // A launcher that vanished between scan and cure is not an error.
    }

    const cured = cureDesktopFile(source);
    // Nothing in this file starts a Chromium-family binary, so there is no
    // flag to add and no report to make about it.
    if (!cured.chromium) continue;

    const state = stateFor(row, row.desktopId);
    state.found.push(entry.source);

    const program = execProgram(source.match(/^\s*Exec\s*=\s*(.*)$/m)?.[1] ?? "");
    if (program) programs.set(program, row);

    // The override must carry the same basename as the file it shadows: that
    // equality is the whole of freedesktop's precedence rule.
    const target = path.join(deps.userApplicationsDir, path.basename(entry.source));

    // Every Exec line already carries the flag — in the override we wrote last
    // boot, or in the packaged file itself. Writing again would be churn in a
    // file the user owns, so this run leaves it alone.
    if (!cured.changed) continue;

    try {
      fs.mkdirSync(deps.userApplicationsDir, { recursive: true });
      fs.writeFileSync(target, cured.text, "utf8");
      state.wrote.push(target);
    } catch {
      continue;
    }
  }

  cureInPlace(deps, programs, stateFor);

  const report: CureReport = { cured: [], alreadyCured: [], needsRestart: [] };
  const rowsById = new Map(deps.rows.map((row) => [row.desktopId, row]));
  for (const state of states.values()) {
    if (state.found.length === 0) continue;
    const record = { name: state.name, desktopId: state.desktopId, launchers: state.wrote };
    const row = rowsById.get(state.desktopId);
    if (state.wrote.length > 0) {
      report.cured.push(record);
      if (row?.running) report.needsRestart.push(state.name);
    } else {
      report.alreadyCured.push({ ...record, launchers: [] });
      // Still running from before the cure: readable is the proof it took.
      if (row?.running && !row.readable) report.needsRestart.push(state.name);
    }
  }

  return report;
}

/**
 * Cure the launchers that cannot be shadowed: autostart entries and desktop
 * icons, rewritten where they sit.
 *
 * A file here is only touched when it starts a program that a permitted
 * application's own launcher starts — matched on the Exec program rather than
 * the filename, because an autostart entry is routinely named for the feature
 * ("discord-tray.desktop") rather than the application. The match is
 * deliberately loose and the permitted set is what bounds it: the worst a
 * wrong match can do is add an ignored flag to a launcher for a program the
 * user already granted access to.
 *
 * Never creates a file, never creates a directory: an autostart entry the user
 * does not have is a choice they made, not a gap for the hub to fill.
 */
function cureInPlace(
  deps: CureDeps,
  programs: Map<string, PermissionRow>,
  stateFor: (row: PermissionRow, desktopId: string) => { wrote: string[]; found: string[] },
): void {
  if (!deps.inPlaceDirs?.length) return;
  if (programs.size === 0) return;

  const permitted = [...programs.values()];

  for (const dir of deps.inPlaceDirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // A directory this machine does not have is not an error.
    }

    for (const name of names) {
      if (!name.endsWith(".desktop")) continue;
      const file = path.join(dir, name);

      let source: string;
      try {
        source = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }

      const cured = cureDesktopFile(source);
      if (!cured.chromium) continue;

      // Which permitted application this launcher belongs to: its own id if the
      // filename matches one, otherwise whatever program its Exec line starts.
      const id = name.replace(/\.desktop$/, "");
      const exec = source.match(/^\s*Exec\s*=\s*(.*)$/m)?.[1];
      const program = exec ? execProgram(exec) : undefined;
      const row =
        permitted.find((candidate) => candidate.desktopId === id || candidate.desktopId === name) ??
        (program ? programs.get(program) : undefined);
      if (!row) continue;

      const state = stateFor(row, row.desktopId as string);
      state.found.push(file);
      if (!cured.changed) continue;

      try {
        // Atomic, and in the same directory so the rename cannot cross a
        // filesystem: the session manager may read this file at any moment,
        // and it must never see a half-written one. The original's mode is
        // carried over — a desktop icon is commonly executable, and a cured
        // copy that lost that bit would stop being launchable.
        const mode = fs.statSync(file).mode;
        const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, cured.text, { encoding: "utf8", mode });
        fs.renameSync(temporary, file);
        state.wrote.push(file);
      } catch {
        continue;
      }
    }
  }
}
