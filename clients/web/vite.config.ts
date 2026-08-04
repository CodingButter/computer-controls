import { defineConfig } from "vite";

/**
 * Dev proxy to the server layer. In dev, Vite serves the PWA on its own port
 * and proxies /session, /ws, and /turn to the Python server (default
 * localhost:8000). In production, the server serves the built static assets
 * from `/`, so no proxy is needed.
 */
export default defineConfig({
  server: {
    proxy: {
      "/session": "http://localhost:8000",
      "/turn": "http://localhost:8000",
      "/healthz": "http://localhost:8000",
      "/ws": {
        target: "ws://localhost:8000",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
