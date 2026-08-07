import type { Metadata, Viewport } from "next";
import "./globals.css";

import { Shell } from "@/components/shell/shell";
import { ServiceWorker } from "@/components/shell/service-worker";
import { THEME } from "@/theme";

export const metadata: Metadata = {
  title: "Computer Controls",
  description: "The hub's dashboard.",
  // The manifest is what turns this page into something a phone can install.
  // It is served by the hub out of client/public, not exported from here — the
  // dashboard has no public directory and the hub already owns the origin.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    // iOS reads none of the manifest for standalone display; it wants these.
    capable: true,
    title: "Controls",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: THEME.background,
  // A dashboard on a phone is only usable if it is laid out for the phone, and
  // viewport-fit=cover is what lets the navy run under the notch instead of
  // leaving white bars around an app that is meant to be dark.
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Shell>{children}</Shell>
        <ServiceWorker />
      </body>
    </html>
  );
}
