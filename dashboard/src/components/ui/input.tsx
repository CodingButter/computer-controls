import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * One field control, two shapes. The pill is what the design uses for a
 * search or a paste-a-value row; the default is the boxed field. Both wear
 * the same border, focus ring and disabled treatment, because a page that
 * hand-rolls its third input class is a theme quietly coming apart.
 */
const inputVariants = cva(
  "flex h-9 text-sm text-foreground transition-colors placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "w-full rounded-lg border border-border bg-card px-3 py-1",
        pill: "rounded-full border border-accent/40 bg-well px-4 py-1.5",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Input({
  className,
  variant,
  type,
  ...props
}: React.ComponentProps<"input"> & VariantProps<typeof inputVariants>) {
  return <input type={type} className={cn(inputVariants({ variant, className }))} {...props} />;
}

export { Input, inputVariants };
