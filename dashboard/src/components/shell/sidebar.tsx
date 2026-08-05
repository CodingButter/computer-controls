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
/** The mastra logomark, inlined so its fill follows the theme. */
function MastraMark(props: { className?: string }) {
  return (
    <svg viewBox="0 0 34 21" fill="none" aria-hidden className={props.className}>
      <path
        fill="currentColor"
        d="M4.49805 11.6934C6.98237 11.6934 8.99609 13.7081 8.99609 16.1924C8.9959 18.6765 6.98225 20.6904 4.49805 20.6904C2.01394 20.6903 0.000196352 18.6765 0 16.1924C0 13.7081 2.01382 11.6935 4.49805 11.6934ZM10.3867 0C12.8709 0 14.8846 2.01388 14.8848 4.49805C14.8848 4.8377 14.847 5.16846 14.7755 5.48643C14.4618 6.88139 14.1953 8.4633 14.9928 9.65L16.2575 11.5319C16.3363 11.6491 16.4727 11.7115 16.6137 11.703C16.7369 11.6957 16.8525 11.6343 16.9214 11.5318L18.1876 9.64717C18.9772 8.47198 18.7236 6.90783 18.4205 5.52484C18.3523 5.21392 18.3164 4.89094 18.3164 4.55957C18.3167 2.07546 20.3313 0.0615234 22.8154 0.0615234C25.2994 0.0617476 27.3132 2.0756 27.3135 4.55957C27.3135 4.93883 27.2665 5.30712 27.178 5.65896C26.8547 6.94441 26.5817 8.37932 27.2446 9.52714L28.459 11.6301C28.4819 11.6697 28.5245 11.6934 28.5703 11.6934C31.0545 11.6935 33.0684 13.7081 33.0684 16.1924C33.0682 18.6765 31.0544 20.6903 28.5703 20.6904C26.0861 20.6904 24.0725 18.6765 24.0723 16.1924C24.0723 15.8049 24.1212 15.4288 24.2133 15.0701C24.5458 13.7746 24.8298 12.3251 24.1609 11.1668L23.0044 9.16384C22.9656 9.09659 22.8931 9.05859 22.8154 9.05859C22.7983 9.05859 22.7824 9.06614 22.7728 9.08033L21.4896 10.9895C20.686 12.1851 20.9622 13.781 21.284 15.1851C21.3582 15.5089 21.3975 15.8461 21.3975 16.1924C21.3973 18.6764 19.3834 20.6902 16.8994 20.6904C14.4152 20.6904 12.4006 18.6765 12.4004 16.1924C12.4004 15.932 12.4226 15.6768 12.4651 15.4286C12.6859 14.14 12.8459 12.7122 12.1167 11.6271L11.2419 10.3253C10.6829 9.49347 9.71913 9.05932 8.78286 8.70188C7.0906 8.05584 5.88867 6.41734 5.88867 4.49805C5.88886 2.0139 7.90254 3.29835e-05 10.3867 0Z"
      />
    </svg>
  );
}

export function Sidebar({ activePath }: { activePath: string }) {
  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-border bg-well">
      <div className="flex items-center gap-2.5 px-5 pb-3 pt-5">
        <MastraMark className="h-5 w-8 text-foreground" />
        <span className="text-lg font-semibold tracking-wide text-foreground">mastra</span>
      </div>

      <div className="mx-4 mb-3 rounded-lg border border-border px-3 py-2">
        <p className="text-xs font-medium text-foreground">Local Admin</p>
        <p className="text-xs text-muted">this machine</p>
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

    </aside>
  );
}
