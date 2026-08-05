"use client";

import { cn } from "@/lib/utils";

/**
 * The ON/OFF toggle of the designs: a labelled switch with the state written
 * on its face, because a permission toggle is exactly the control whose state
 * must never be ambiguous. Hand-rolled on a button with the switch role — no
 * new dependency for one control.
 */
export function Switch(props: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  "aria-label": string;
}) {
  const { checked, onCheckedChange } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={props["aria-label"]}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex h-6 w-14 shrink-0 cursor-pointer items-center rounded-full px-1 text-[10px] font-semibold uppercase transition-colors",
        checked ? "justify-between bg-accent text-well" : "justify-between bg-border text-muted",
      )}
    >
      {checked ? (
        <>
          <span className="pl-1">on</span>
          <span className="h-4 w-4 rounded-full bg-well" />
        </>
      ) : (
        <>
          <span className="h-4 w-4 rounded-full bg-muted/60" />
          <span className="pr-1">off</span>
        </>
      )}
    </button>
  );
}
