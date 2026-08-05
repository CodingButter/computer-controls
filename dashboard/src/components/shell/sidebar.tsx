import Link from "next/link";

import { cn } from "@/lib/utils";
import { NAV_ENTRIES, isActive } from "./nav";

/**
 * The left rail: brand, the nine destinations, and who is signed in.
 *
 * Pure on purpose — the active path arrives as a prop so the component can be
 * rendered (and tested) without a router. The thin client wrapper in shell.tsx
 * is the only place that asks Next where the visitor is.
 */
export function Sidebar({ activePath }: { activePath: string }) {
  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-border bg-well">
      <div className="flex items-center gap-2 px-5 py-5">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />
        <span className="text-sm font-semibold tracking-wide text-foreground">
          Computer Controls
        </span>
      </div>

      <nav aria-label="Primary" className="flex-1 space-y-1 px-3 py-2">
        {NAV_ENTRIES.map((entry) => {
          const active = isActive(activePath, entry.href);
          const className = cn(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
            active
              ? "bg-accent/15 font-medium text-accent"
              : "text-muted hover:bg-card hover:text-foreground",
          );
          const body = (
            <>
              <entry.icon aria-hidden className="h-4 w-4" />
              {entry.label}
            </>
          );
          // Chat and orb are other faces of the hub, not routes of this app:
          // a plain anchor leaves the SPA rather than asking the router to
          // find a page that deliberately is not here.
          return entry.external ? (
            <a key={entry.href} href={entry.href} data-active={active} className={className}>
              {body}
            </a>
          ) : (
            <Link key={entry.href} href={entry.href} data-active={active} className={className}>
              {body}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border px-5 py-4">
        <p className="text-xs font-medium text-foreground">Local Admin</p>
        <p className="text-xs text-muted">this machine</p>
      </div>
    </aside>
  );
}
