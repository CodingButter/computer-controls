/**
 * The hub's single source of nav links.
 *
 * Both the dashboard sidebar and the standalone pages (orb, chat) read these
 * same entries, so a link added here reaches every face the hub serves
 * without a second hand-maintained copy drifting out of step. Icons are
 * deliberately absent — they are presentation, and the dashboard maps an
 * icon to an href locally. The data is what must not drift, and this is the
 * one place it lives.
 *
 * Chat and Orb are marked external because they are not pages of the
 * dashboard app: they are the hub's other faces, served by the same process
 * from its own static root.
 */
export type NavEntry = {
  label: string;
  href: string;
  /** True for pages that live outside the dashboard app (chat, orb). */
  external: boolean;
};

export const NAV_ENTRIES: readonly NavEntry[] = [
  { label: "Overview", href: "/", external: false },
  { label: "Chat", href: "/chat", external: true },
  { label: "Orb", href: "/orb", external: true },
  { label: "Permissions", href: "/permissions", external: false },
  { label: "Audit", href: "/audit", external: false },
  { label: "Voice", href: "/voice", external: false },
  { label: "Models", href: "/models", external: false },
  { label: "Plugins", href: "/plugins", external: false },
  { label: "Devices", href: "/devices", external: false },
  { label: "Settings", href: "/settings", external: false },
] as const;

/**
 * Whether a nav entry is the one the visitor is on.
 *
 * Exact match for the root — "/" is a prefix of everything, and an Overview
 * pill that never went out would be wrong on every other page. Prefix match
 * for the rest so a detail route (say /audit/some-entry later) keeps its
 * section lit.
 */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
