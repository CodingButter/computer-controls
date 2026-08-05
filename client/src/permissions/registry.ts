import {
  MalformedConfigError,
  OPEN_MODE,
  readScopesConfig,
  writePermissions,
  type PermissionsMode,
} from "./config-file.ts";
import type { Census } from "./daemon.ts";
import type { DesktopEntryApp } from "./desktop-entries.ts";

export { MalformedConfigError };

/**
 * The hub's own reading of the user's permission registry.
 *
 * One source of truth — the config file the daemon's ceiling reads — viewed
 * two ways: merged with the census for the page's checklist, and boiled down
 * to "which installed applications are unpermitted" for the no-permission
 * signal. Both readings re-read the file per ask, because the daemon does the
 * same and two components disagreeing about a file they both read would be a
 * cache, not a design.
 */

/**
 * How far inside one application an agent may go, as the page puts the
 * question.
 *
 * Three of these are the states a person chooses between. `custom` is the
 * fourth answer the file can give and the page cannot ask for: a hand-written
 * `applicationClasses` entry naming something in between — `edit` without
 * `activate`, say. The daemon honours it, so the page shows it rather than
 * rounding it to whichever neighbour looks close, because rounding it would
 * mean describing a permission the user does not have.
 */
export type AppAccess = "off" | "view" | "interact" | "custom";

export type PermissionRow = {
  name: string;
  permitted: boolean;
  /** What the file permits inside this application, as a state the page can draw. */
  access: AppAccess;
  /** The classes actually in force — carried so a `custom` row can say what it is. */
  classes?: string[];
  running: boolean;
  /** Running on the accessibility bus. False while running means "needs a restart to become readable". */
  readable: boolean;
  /** Present when the application has a launcher entry; the handle curing uses. */
  desktopId?: string;
  /**
   * The name the daemon's census reported, when it differs from the launcher's.
   * GNOME apps launch as "Files" but stand on the bus as "org.gnome.Nautilus";
   * both are the same application and the same toggle, so the row keeps the
   * friendly name for display and this one for the ceiling's benefit.
   */
  censusName?: string;
};

export type PermissionsView = {
  mode: PermissionsMode;
  daemon: { reachable: true } | { reachable: false; reason: string };
  /**
   * `scopes.operationClasses`, filled in up its ladder — the widest any single
   * application can be. Carried so the page can say why "interact" is greyed
   * out on a desktop whose global classes stop at `observe`, rather than
   * offering a choice that would change nothing.
   */
  ceiling: string[];
  applications: PermissionRow[];
};

export type RegistryDeps = {
  configPath: string;
  readCensus: () => Promise<Census>;
  scanInstalled: () => DesktopEntryApp[];
};

/**
 * The ceiling's own matching rule, mirrored: casefolded substring, both
 * directions. Mirrored rather than approximated because the page's "permitted"
 * column is a prediction of what the daemon will do, and a prediction made
 * under different rules is a lie waiting for a near-collision — "disc" in the
 * list really does cover "discord", and the page must say so.
 */
function matches(name: string, entries: string[]): boolean {
  const folded = name.toLowerCase();
  return entries.some((entry) => {
    const entryFolded = entry.toLowerCase();
    return folded.includes(entryFolded) || entryFolded.includes(folded);
  });
}

/** "org.gnome.Nautilus.desktop" → "org.gnome.Nautilus" — the id without its suffix. */
function desktopIdStem(desktopId: string | undefined): string | undefined {
  if (!desktopId) return undefined;
  return desktopId.endsWith(".desktop") ? desktopId.slice(0, -".desktop".length) : desktopId;
}

/**
 * Every name this row is known by: the launcher's, the desktop-file id's stem,
 * and the census's when the daemon uses a different one. One application, one
 * toggle — un-permitting it must remove them all.
 */
function identitiesOf(row: {
  name: string;
  desktopId?: string;
  censusName?: string;
}): string[] {
  const names = new Set<string>([row.name]);
  const stem = desktopIdStem(row.desktopId);
  if (stem) names.add(stem);
  if (row.censusName) names.add(row.censusName);
  return [...names];
}

/**
 * The names the ceiling will actually test. The daemon matches its OWN name
 * for the application — the census's — so when that name is known it is the
 * whole prediction; guessing from the launcher name too would show permitted
 * where the daemon refuses. Only while the census name is unknowable (the app
 * is not on the bus) do the launcher name and the id stem stand in as the
 * best available guesses.
 */
function predictionNamesOf(row: {
  name: string;
  desktopId?: string;
  censusName?: string;
}): string[] {
  if (row.censusName) return [row.censusName];
  const names = new Set<string>([row.name]);
  const stem = desktopIdStem(row.desktopId);
  if (stem) names.add(stem);
  return [...names];
}

/**
 * The names worth writing to the allowlist for one permitted row: the name
 * the daemon actually uses when it can be known (the census's), else the id
 * stem alongside the launcher name — the stem is what GNOME apps stand on the
 * bus as, and writing only the friendly name would permit an application the
 * ceiling then fails to recognise when it starts.
 */
function writeNamesFor(row: PermissionRow): string[] {
  if (row.censusName) return [row.censusName];
  if (row.running) return [row.name];
  const stem = desktopIdStem(row.desktopId);
  return stem && stem.toLowerCase() !== row.name.toLowerCase()
    ? [row.name, stem]
    : [row.name];
}

export function derivePermitted(
  name: string,
  mode: PermissionsMode,
  applications: string[],
  blockedApplications: string[],
): boolean {
  // Blocked wins over everything, exactly as it does in the ceiling.
  if (matches(name, blockedApplications)) return false;
  if (mode === OPEN_MODE) return true;
  // Per-application: nothing named means nothing permitted.
  return matches(name, applications);
}

/**
 * The operation ladder, in severity order — `security.OPERATION_CLASSES`.
 * Held here as the page's own copy for the same reason the settings surface
 * holds one: this package does not reach into the generated bindings. The
 * ordering is the whole point, so it is a list and not a set.
 */
export const OPERATION_CLASSES = [
  "observe",
  "edit",
  "activate",
  "submit",
  "destructive",
] as const;

/** `security.implied_classes`: these, and everything the highest of them contains. */
function impliedClasses(classes: string[]): string[] {
  const held = OPERATION_CLASSES.filter((name) =>
    classes.some((entry) => entry.trim().toLowerCase() === name),
  );
  if (held.length === 0) return [];
  return OPERATION_CLASSES.slice(0, OPERATION_CLASSES.indexOf(held[held.length - 1]!) + 1);
}

/**
 * `security.Ceiling.classes_for`, mirrored: what the file permits inside one
 * application, or `undefined` when it says nothing and the general answer
 * stands.
 *
 * Every pattern that names this application votes and the answer is their
 * intersection — the narrowest thing they all agree to — so the prediction
 * cannot disagree with the daemon just because the user reordered their file.
 * The result is then capped by the global classes, because an implication is
 * never allowed to hand out what `operationClasses` withholds everywhere.
 */
export function deriveClasses(
  name: string,
  applicationClasses: Record<string, string[]>,
  globalClasses: string[],
): string[] | undefined {
  const folded = name.toLowerCase();
  const voters = Object.entries(applicationClasses).filter(([pattern]) => {
    const patternFolded = pattern.trim().toLowerCase();
    return folded.includes(patternFolded) || patternFolded.includes(folded);
  });
  if (voters.length === 0) return undefined;

  let agreed: string[] | undefined;
  for (const [, classes] of voters) {
    const implied = impliedClasses(classes);
    agreed = agreed === undefined ? implied : agreed.filter((entry) => implied.includes(entry));
  }
  const capped = globalClasses.length > 0 ? impliedClasses(globalClasses) : ["observe"];
  return (agreed ?? []).filter((entry) => capped.includes(entry));
}

/**
 * Which of the page's three states this application is in.
 *
 * `interact` is the absence of an entry rather than an entry naming every
 * class: absence is what the daemon reads as "the general answer stands", it
 * survives the user later narrowing `operationClasses`, and it keeps the file
 * free of lines that only restate the ceiling.
 */
export function deriveAccess(
  name: string,
  mode: PermissionsMode,
  applications: string[],
  blockedApplications: string[],
  applicationClasses: Record<string, string[]>,
  globalClasses: string[],
): { access: AppAccess; classes?: string[] } {
  if (!derivePermitted(name, mode, applications, blockedApplications)) return { access: "off" };

  // `security.Ceiling.from_config`: an absent `operationClasses` is `observe`,
  // not everything. A page that read the absence as "interact" would draw a
  // whole desktop of interactive applications on the default config, where the
  // daemon refuses every click — the prediction disagreeing with the daemon in
  // the one direction that matters.
  const ceiling = globalClasses.length > 0 ? impliedClasses(globalClasses) : ["observe"];
  const observeOnly = ceiling.length === 1 && ceiling[0] === "observe";

  const classes = deriveClasses(name, applicationClasses, globalClasses);
  // No entry: the general answer stands, and the general answer is the ceiling.
  if (classes === undefined) {
    return observeOnly ? { access: "view", classes: ceiling } : { access: "interact" };
  }
  if (classes.length === 1 && classes[0] === "observe") return { access: "view", classes };
  // An entry that already names everything the ceiling permits is interact
  // spelled the long way; anything else is a shape this page did not write.
  if (classes.length === ceiling.length) return { access: "interact", classes };
  return { access: "custom", classes };
}

export type PermissionRegistry = {
  view(): Promise<PermissionsView>;
  setAccess(app: string, access: AppAccess): Promise<PermissionsView>;
  /** Exact names of applications that exist on this machine and are not permitted. */
  unpermittedApps(): Promise<string[]>;
};

export function createPermissionRegistry(deps: RegistryDeps): PermissionRegistry {
  const merge = async (): Promise<PermissionsView> => {
    const scopes = readScopesConfig(deps.configPath);
    const census = await deps.readCensus();
    const installed = deps.scanInstalled();

    // Merged by casefolded name AND by desktop-file id stem: the census's
    // names are the daemon's, the launcher's are the desktop file's, and the
    // two frequently disagree about the same application — GNOME's launcher
    // says "Files" where the bus says "org.gnome.Nautilus", and the id stem
    // is the thread connecting them. When any handle agrees, they are one row.
    const rows = new Map<string, PermissionRow>();
    const byStem = new Map<string, PermissionRow>();
    for (const app of installed) {
      const row: PermissionRow = {
        name: app.name,
        permitted: false,
        access: "off",
        running: false,
        readable: false,
        desktopId: app.desktopId,
      };
      rows.set(app.name.toLowerCase(), row);
      const stem = desktopIdStem(app.desktopId);
      if (stem) byStem.set(stem.toLowerCase(), row);
    }
    if (census.reachable) {
      for (const app of census.applications) {
        const folded = app.name.toLowerCase();
        const existing = rows.get(folded) ?? byStem.get(folded);
        if (existing) {
          existing.running = true;
          existing.readable = app.readable;
          if (existing.name.toLowerCase() !== folded) existing.censusName = app.name;
        } else {
          rows.set(folded, {
            name: app.name,
            permitted: false,
            access: "off",
            running: true,
            readable: app.readable,
          });
        }
      }
    }

    const applications = [...new Set(rows.values())]
      .map((row) => {
        // Predicted with the names the ceiling will actually test — the
        // census's when known, the launcher's and the stem's guesses when not.
        const names = predictionNamesOf(row);
        const permitted = names.some((name) =>
          derivePermitted(name, scopes.mode, scopes.applications, scopes.blockedApplications),
        );
        // The narrowest reading among the names this row answers to: the same
        // instinct as the ceiling's intersection, applied to the ambiguity the
        // page has and the daemon does not.
        const states = names.map((name) =>
          deriveAccess(
            name,
            scopes.mode,
            scopes.applications,
            scopes.blockedApplications,
            scopes.applicationClasses,
            scopes.classes,
          ),
        );
        const narrowest =
          states.find((state) => state.access === "custom") ??
          states.find((state) => state.access === "view") ??
          states.find((state) => state.access === "interact") ??
          states[0]!;
        return {
          ...row,
          permitted,
          access: permitted ? narrowest.access : ("off" as AppAccess),
          ...(permitted && narrowest.classes ? { classes: narrowest.classes } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      mode: scopes.mode,
      daemon: census.reachable
        ? { reachable: true }
        : { reachable: false, reason: census.reason },
      ceiling: scopes.classes.length > 0 ? impliedClasses(scopes.classes) : ["observe"],
      applications,
    };
  };

  return {
    view: merge,

    async setAccess(app: string, access: AppAccess): Promise<PermissionsView> {
      const scopes = readScopesConfig(deps.configPath);
      const current = await merge();
      const permitted = access !== "off";

      // The row being toggled, found by any of its names — the page sends the
      // display name, but "Files" and "org.gnome.Nautilus" are one switch.
      const folded = app.toLowerCase();
      const row = current.applications.find((candidate) =>
        identitiesOf(candidate).some((name) => name.toLowerCase() === folded),
      );
      const identities = row ? identitiesOf(row) : [app];

      let names: string[];
      if (scopes.mode === OPEN_MODE) {
        // The transition case. Open mode has no list, so the first toggle must
        // write the mode and the list in the same atomic breath — and the list
        // it writes is every application this page can currently see, so that
        // flipping one switch never silently revokes the rest of the desktop.
        names = current.applications
          .filter((candidate) => candidate.permitted)
          .flatMap((candidate) => writeNamesFor(candidate));
      } else {
        names = [...scopes.applications];
      }

      // Exact names in, exact names out: the ceiling matches substrings, so
      // writing a fragment would permit more than the user clicked — and a
      // row with several names must have every one of them removed, or the
      // leftover identity would keep the door open behind the toggle.
      const foldedIdentities = new Set(identities.map((name) => name.toLowerCase()));
      names = names.filter((name) => !foldedIdentities.has(name.toLowerCase()));
      const writeNames = row ? writeNamesFor(row) : [app];
      if (permitted) names.push(...writeNames);

      // The class map is edited by the same rule as the list: every name this
      // row answers to comes out first, because a leftover pattern would go on
      // capping the application from behind the control that just changed it.
      const applicationClasses: Record<string, string[]> = {};
      for (const [pattern, classes] of Object.entries(scopes.applicationClasses)) {
        if (!foldedIdentities.has(pattern.trim().toLowerCase())) {
          applicationClasses[pattern] = classes;
        }
      }
      if (access === "view") {
        // `observe` alone, written as the user's own word. The ladder is
        // filled in where the answer is read, so the file keeps saying the
        // narrow thing that was actually chosen.
        for (const name of writeNames) applicationClasses[name] = ["observe"];
      }

      writePermissions(
        deps.configPath,
        scopes.document,
        [...new Set(names)].sort(),
        applicationClasses,
      );
      return await merge();
    },

    async unpermittedApps(): Promise<string[]> {
      const view = await merge();
      return view.applications.filter((row) => !row.permitted).map((row) => row.name);
    },
  };
}
