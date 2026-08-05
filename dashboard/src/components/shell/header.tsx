import { Calendar, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The top bar: a search field and a date filter, per the approved designs.
 *
 * Both are presentational this wave — the pages they will filter arrive over
 * the next phases, and a control that pretended to filter before then would
 * be a lie with a focus ring.
 */
export function Header() {
  return (
    <header className="flex items-center gap-4 border-b border-border bg-background px-6 py-3">
      <div className="relative max-w-md flex-1">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
        />
        <Input type="search" placeholder="Search" className="pl-9" aria-label="Search" />
      </div>
      <div className="flex-1" />
      <Button variant="outline" size="sm">
        <Calendar aria-hidden className="h-4 w-4" />
        Last 24 hours
      </Button>
    </header>
  );
}
