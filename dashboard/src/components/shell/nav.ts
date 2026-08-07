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

// The hub's nav links live in exactly one place: client/src/nav/entries.ts.
// Both the dashboard sidebar and the standalone-page drawer read that same
// source (the drawer over the network via /api/nav, the sidebar at build time
// via this import). A second hand-maintained copy of the nine links is the
// bug this issue exists to close.
//
// What is NOT shared is the icon — that is presentation, dashboard-local, and
// has no business in the framework-free data the hub serves. We key it by href
// so the shared data stays the single source of truth for what the links ARE.
import { NAV_ENTRIES as HUB_ENTRIES, isActive } from "@hub/nav/entries";

export { isActive };

const ICON_BY_HREF: Record<string, LucideIcon> = {
  "/": LayoutDashboard,
  "/chat": MessagesSquare,
  "/orb": Bot,
  "/permissions": ShieldCheck,
  "/audit": ScrollText,
  "/models": Boxes,
  "/plugins": Puzzle,
  "/devices": MonitorSmartphone,
  "/settings": Settings,
};

export type NavEntry = {
  label: string;
  href: string;
  icon: LucideIcon;
  external: boolean;
};

export const NAV_ENTRIES: readonly NavEntry[] = HUB_ENTRIES.map((entry) => ({
  ...entry,
  icon: ICON_BY_HREF[entry.href],
}));
