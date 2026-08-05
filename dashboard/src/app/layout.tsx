import type { Metadata } from "next";
import "./globals.css";

import { Shell } from "@/components/shell/shell";

export const metadata: Metadata = {
  title: "Computer Controls",
  description: "The hub's dashboard.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
