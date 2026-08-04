import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Gate tests spend a real credential against a real model provider. They are
    // run deliberately with `pnpm test:gate`, never as part of the default lane.
    exclude: ["**/node_modules/**", "**/*.gate.test.ts"],
  },
});
