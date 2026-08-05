import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Computer Controls",
  description: "The hub's dashboard.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
