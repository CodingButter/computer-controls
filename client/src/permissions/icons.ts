import fs from "node:fs";
import path from "node:path";

import type { DesktopEntryApp } from "./desktop-entries.ts";

/**
 * Application icons, served from the machine itself.
 *
 * A .desktop entry's Icon= names either a theme icon or an absolute file.
 * The freedesktop icon themes on disk hold the actual images, so there is no
 * network anywhere in this answer: the hub resolves the name the way a
 * launcher would — theme directories by preferred size, then the pixmaps
 * pile — and streams the file. The lookup is keyed by desktop-file id against
 * entries we scanned ourselves; no request parameter ever becomes a path.
 */

export type IconFile = {
  body: Buffer;
  contentType: string;
};

export type IconSource = (desktopId: string) => IconFile | undefined;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** Biggest-useful-first: the page shows icons small, but scaling down is free. */
const SIZE_PREFERENCE = ["64x64", "128x128", "48x48", "256x256", "512x512", "scalable", "32x32"];

/** hicolor is the spec's fallback theme every app installs into; Yaru and
 * Adwaita carry the platform icons for GNOME's own apps on this distro. */
const THEME_PREFERENCE = ["hicolor", "Yaru", "Adwaita"];

/**
 * Where in a theme an icon may stand. Third-party apps live in apps/, but
 * plenty of system .desktop entries name a stock icon from another context —
 * "preferences-system-network" is in categories/, "input-keyboard" in
 * devices/, "dialog-information" in status/. apps/ stays first because an
 * application's own icon outranks a stock lookalike of the same name.
 */
const CONTEXT_PREFERENCE = ["apps", "categories", "devices", "status", "places", "mimetypes"];

export type IconLookupDirs = {
  /** Roots holding theme directories, most specific first (user then system). */
  iconRoots: string[];
  /** The legacy flat pile, e.g. /usr/share/pixmaps. */
  pixmapsDirs: string[];
};

export function defaultIconDirs(home: string): IconLookupDirs {
  return {
    iconRoots: [path.join(home, ".local", "share", "icons"), "/usr/share/icons"],
    pixmapsDirs: ["/usr/share/pixmaps"],
  };
}

function readable(candidate: string): IconFile | undefined {
  const contentType = CONTENT_TYPES[path.extname(candidate).toLowerCase()];
  if (!contentType) return undefined;
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return undefined;
    return { body: fs.readFileSync(candidate), contentType };
  } catch {
    return undefined;
  }
}

/**
 * Resolve an Icon= value to image bytes, or honestly nothing.
 *
 * An absolute path is trusted as far as its own existence — it came from a
 * .desktop file on this machine, not from a request. A bare name is searched
 * through the theme directories; a name with a separator in it is neither
 * form and is refused.
 */
export function resolveIcon(icon: string, dirs: IconLookupDirs): IconFile | undefined {
  if (path.isAbsolute(icon)) return readable(icon);
  if (icon.includes("/") || icon.includes("..")) return undefined;

  // The spec says a themed name carries no extension; some entries carry one
  // anyway, and the theme files never do — strip it for the search.
  const name = icon.replace(/\.(png|svg|xpm)$/i, "");

  for (const context of CONTEXT_PREFERENCE) {
    for (const root of dirs.iconRoots) {
      for (const theme of THEME_PREFERENCE) {
        for (const size of SIZE_PREFERENCE) {
          for (const ext of [".png", ".svg"]) {
            const hit = readable(path.join(root, theme, size, context, `${name}${ext}`));
            if (hit) return hit;
          }
        }
      }
    }
  }
  for (const dir of dirs.pixmapsDirs) {
    for (const ext of [".png", ".svg"]) {
      const hit = readable(path.join(dir, `${name}${ext}`));
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * The route's whole vocabulary: desktop-file ids we scanned ourselves. An id
 * the scan never produced resolves to nothing, which is what keeps a request
 * parameter from ever choosing a file.
 */
export function createIconSource(
  scanInstalled: () => DesktopEntryApp[],
  dirs: IconLookupDirs,
): IconSource {
  return (desktopId) => {
    const entry = scanInstalled().find((app) => app.desktopId === desktopId);
    if (!entry?.icon) return undefined;
    return resolveIcon(entry.icon, dirs);
  };
}
