"use client";

import { usePathname } from "next/navigation";

import { Header } from "./header";
import { Sidebar } from "./sidebar";

/**
 * The frame every page sits in: sidebar on the left, header across the top,
 * the page in the remaining well.
 *
 * This is the one client component in the shell — it exists only to ask the
 * router where the visitor is and hand that to the pure sidebar.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar activePath={pathname} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
