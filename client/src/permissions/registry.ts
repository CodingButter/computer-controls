import {
  MalformedConfigError,
  OPEN_MODE,
  readScopesConfig,
  writePermittedApplications,
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

export type PermissionRow = {
  name: string;
  permitted: boolean;
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

export type PermissionRegistry = {
  view(): Promise<PermissionsView>;
  setPermitted(app: string, permitted: boolean): Promise<PermissionsView>;
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
            running: true,
            readable: app.readable,
          });
        }
      }
    }

    const applications = [...new Set(rows.values())]
      .map((row) => ({
        ...row,
        // Predicted with the names the ceiling will actually test — the
        // census's when known, the launcher's and the stem's guesses when not.
        permitted: predictionNamesOf(row).some((name) =>
          derivePermitted(name, scopes.mode, scopes.applications, scopes.blockedApplications),
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      mode: scopes.mode,
      daemon: census.reachable
        ? { reachable: true }
        : { reachable: false, reason: census.reason },
      applications,
    };
  };

  return {
    view: merge,

    async setPermitted(app: string, permitted: boolean): Promise<PermissionsView> {
      const scopes = readScopesConfig(deps.configPath);
      const current = await merge();

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
      if (permitted) names.push(...(row ? writeNamesFor(row) : [app]));

      writePermittedApplications(
        deps.configPath,
        scopes.document,
        [...new Set(names)].sort(),
      );
      return await merge();
    },

    async unpermittedApps(): Promise<string[]> {
      const view = await merge();
      return view.applications.filter((row) => !row.permitted).map((row) => row.name);
    },
  };
}
