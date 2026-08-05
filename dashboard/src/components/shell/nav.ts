import {
  Bot,
  Boxes,
  LayoutDashboard,
  MessagesSquare,
  MonitorSmartphone,
  Puzzle,
  ScrollText,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

/**
 * The sidebar's vocabulary, as data.
 *
 * Chat and Orb are marked external because they are not pages of this app:
 * they are the hub's other faces, served by the same process from its own
 * static root. The sidebar links out of the SPA to them with a plain anchor —
 * rebuilding either page here is exactly what the plan forbids.
 */
export type NavEntry = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** True for pages that live outside this app (chat, orb). */
  external: boolean;
};

export const NAV_ENTRIES: readonly NavEntry[] = [
  { label: "Overview", href: "/", icon: LayoutDashboard, external: false },
  { label: "Chat", href: "/chat", icon: MessagesSquare, external: true },
  { label: "Orb", href: "/orb", icon: Bot, external: true },
  { label: "Permissions", href: "/permissions", icon: ShieldCheck, external: false },
  { label: "Audit", href: "/audit", icon: ScrollText, external: false },
  { label: "Models", href: "/models", icon: Boxes, external: false },
  { label: "Plugins", href: "/plugins", icon: Puzzle, external: false },
  { label: "Devices", href: "/devices", icon: MonitorSmartphone, external: false },
  { label: "Settings", href: "/settings", icon: Settings, external: false },
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
