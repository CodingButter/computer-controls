import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THEME } from "./theme";

// The palette lives twice: as named constants in theme.ts and as CSS variables
// in globals.css. These tests are the seam holding them together — and the
// guard against the palette drifting away from the approved designs.

const APPROVED_NAVY = "#101b2d";
const APPROVED_CYAN = "#0de6f9";

const globalsCss = readFileSync(
  fileURLToPath(new URL("./app/globals.css", import.meta.url)),
  "utf8",
);

describe("the theme", () => {
  it("keeps the approved navy ground", () => {
    expect(THEME.background).toBe(APPROVED_NAVY);
  });

  it("keeps the approved cyan accent", () => {
    expect(THEME.accent).toBe(APPROVED_CYAN);
  });

  it("agrees with globals.css on every token", () => {
    for (const [name, value] of Object.entries(THEME)) {
      expect(globalsCss, `token "${name}"`).toContain(value);
    }
  });
});
