import { defineConfig } from "vitest/config";

/**
 * Tests that touch the DOM (state-view rendering) use jsdom.
 * The connect tests don't need DOM but need fetch/WebSocket mocks — they
 * work fine in jsdom too.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
  },
});
