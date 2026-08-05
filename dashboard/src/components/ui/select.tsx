import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A native select wearing the same clothes as Input: one border token, one
 * focus ring, one disabled treatment. A settings page that grows a second
 * kind of field control is how a theme starts to drift.
 */
function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "flex h-9 w-full rounded-lg border border-border bg-card px-3 py-1 text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/** The label a field wears: the same muted caption every card uses. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

export { Field, Select };
