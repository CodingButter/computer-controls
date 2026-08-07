import path from "node:path";

import type { NextConfig } from "next";

// The dashboard is a static export on purpose: the Hono hub in client/ is the
// one process, the one port, and the one .deb story. `next build` writes the
// whole application to out/, and the hub serves those bytes at / — there is no
// Next server anywhere in the shipped product.
const nextConfig: NextConfig = {
  output: "export",
  // The export has no image-optimizer server to lean on.
  images: { unoptimized: true },
  // The sidebar imports the hub's shared nav entries from ../client/src —
  // Turbopack refuses to resolve anything above its filesystem root, so the
  // root is the repository, not this package (#167).
  turbopack: {
    root: path.join(__dirname, ".."),
  },
};

export default nextConfig;
