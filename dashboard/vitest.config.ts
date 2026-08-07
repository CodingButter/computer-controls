import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The same alias tsconfig gives the app code; without it every component
    // import fails at test time only.
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@hub": path.resolve(import.meta.dirname, "../client/src"),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
