import { defineConfig } from "vitest/config";

/**
 * The gate suite: assertions about the host runtime's real behavior, run on a
 * machine that actually has the host. Separate from the default run so that a
 * box without Mastra Code reports "not run" instead of a hollow green — a gate
 * that passes against a stand-in runtime is worse than no gate at all.
 *
 * `@mastra/core` is the host's package, symlinked into node_modules the same way
 * `mastracode` already is. Node's own resolution then handles the subpaths.
 */
export default defineConfig({
  test: {
    include: ["**/*.gate.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
