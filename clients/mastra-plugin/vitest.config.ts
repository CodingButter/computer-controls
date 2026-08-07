import { defineConfig } from "vitest/config";

/**
 * The gate suite is excluded from the default run: it asserts against the host
 * runtime, which is present on a developer's machine and absent on a bare
 * checkout. `pnpm test:gate` runs it where it can actually mean something.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/*.gate.test.ts"],
  },
});
