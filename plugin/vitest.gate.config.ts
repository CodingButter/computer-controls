import { defineConfig } from "vitest/config";

/**
 * The gate suite: assertions about behavior this plugin depends on but does not
 * own — the framework's notification dispatcher, and a real desktop service on
 * a real socket. Kept out of the default run because a gate is only worth
 * reading when it ran against the real thing, and a box that cannot supply the
 * real thing should report "not run" rather than a hollow green.
 *
 * `@mastra/core` is a declared dependency now, so the framework half of this
 * suite runs anywhere. What makes it meaningful is the exact version pin: the
 * copy under test is the same release the host loads, not merely something with
 * the same shape. If that pin ever drifts from the host's version, these tests
 * stop describing the runtime the plugin is actually loaded into.
 */
export default defineConfig({
  test: {
    include: ["**/*.gate.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
