/**
 * The neutral ports every OS adapter fills in.
 *
 * Nothing in this file knows what an operating system is. That is the point:
 * the hub's core addresses an application by id and asks for its icon, and the
 * adapter underneath decides whether that means an XDG icon theme, an `.icns`
 * inside a bundle, or a resource section in a `.exe`. The daemon already works
 * this way — `backends/` is the only part of it that gets rewritten per OS —
 * and the hub should not have to learn the lesson twice.
 */

/**
 * Which family of desktop conventions an adapter implements.
 *
 * Named for the convention rather than the kernel: "freedesktop" is what the
 * Linux adapter actually follows, and it is equally correct on the BSDs.
 */
export type PlatformId = "freedesktop" | "macos" | "windows";

/**
 * One application this machine has installed.
 *
 * `id` is the hub's handle for it and the only thing the core passes back to
 * the adapter. Its spelling is the adapter's business — a desktop-entry
 * basename here, a bundle identifier on macOS — so the core must never parse
 * it, only carry it.
 */
export type InstalledApplication = {
  id: string;
  /** What a person calls it. The unlocalised name; translating is not this seam's job. */
  name: string;
};

/** Icon bytes plus enough type information for a browser to render them. */
export type ApplicationIcon = {
  bytes: Uint8Array;
  mediaType: string;
};

/**
 * An application's icon, or nothing.
 *
 * Absent is a normal answer, not a failure: plenty of installed applications
 * ship no icon, and a permissions dashboard that threw on those would be a
 * dashboard nobody could open.
 */
export type IconSource = (applicationId: string) => Promise<ApplicationIcon | undefined>;

/** Every application this machine has installed and would show a person. */
export type ScanInstalled = () => Promise<InstalledApplication[]>;

/**
 * One start-on-login entry, described by the side that wants it.
 *
 * The caller says what should start and what a person sees in their session's
 * startup list; the adapter decides what that means on disk — an XDG autostart
 * `.desktop` file here, a LaunchAgent plist or a Run key when those waves come.
 * The split keeps product names out of the adapter and file formats out of the
 * core, the same bargain `InstalledApplication.id` strikes in the other
 * direction.
 */
export type AutostartEntry = {
  /** Basename for the entry file. The adapter picks the directory and suffix. */
  id: string;
  /** What a person sees in their session's startup list. */
  name: string;
  /** The command the session runs at login. */
  exec: string;
};

/**
 * Whether something starts when this person signs in.
 *
 * `read` answers from disk every time rather than from memory, because the
 * file is the person's own and they may edit or delete it behind the hub's
 * back — a cached answer would be the hub disagreeing with the desktop about
 * what the desktop will do. `write` with `enabled: false` removes the entry,
 * and removing what is already absent is a success: the caller asked for a
 * state, not an action.
 */
export type Autostart = {
  /** The file the entry lives in (or would), so a settings page can name what it edits. */
  path: (id: string) => string;
  read: (id: string) => Promise<boolean>;
  write: (entry: AutostartEntry, enabled: boolean) => Promise<void>;
};

/**
 * Where the hub is allowed to write, by this OS's conventions.
 *
 * Two directories rather than one because the OSes that separate them care, and
 * because these two have different fates: config is a person's settings and
 * belongs in a backup, state is the audit log and follows the machine the
 * actions happened on. On Windows that is literally the roaming/local split.
 */
export type HubPaths = {
  config: string;
  state: string;
};

/**
 * What this adapter can actually do, stated up front.
 *
 * An adapter that cannot scan installed applications returns an empty list
 * rather than throwing, so a hub on an unfinished OS still boots. That safety
 * makes "no applications installed" and "this OS has no scanner yet" look
 * identical to a caller, which is exactly the confusion a person hits first.
 * These flags are how the hub tells the two apart out loud.
 */
export type PlatformSupport = {
  installedScan: boolean;
  icons: boolean;
  /**
   * Whether a Chromium-family shortcut can be cured on this OS (#115). The
   * `.desktop` override trick is freedesktop-only by definition; the other
   * families need their own strategy, and until one exists the honest answer
   * is no.
   */
  shortcutCuring: boolean;
  /**
   * Whether a start-on-login entry can be written here. XDG autostart is
   * freedesktop-only by definition, exactly like `shortcutCuring` above; the
   * other families have their own mechanisms, and until an adapter implements
   * one the honest answer is no.
   */
  autostart: boolean;
};

/** The whole OS-facing surface the hub composes at boot. */
export type HubPlatform = {
  id: PlatformId;
  paths: HubPaths;
  scanInstalled: ScanInstalled;
  icons: IconSource;
  autostart: Autostart;
  supports: PlatformSupport;
};
