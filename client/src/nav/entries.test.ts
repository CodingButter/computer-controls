import { describe, expect, it } from "vitest";

import { NAV_ENTRIES, isActive } from "./entries.ts";

describe("the hub's nine nav destinations", () => {
  it("labels, hrefs, and order match what every face of the hub shows", () => {
    expect(NAV_ENTRIES.map((e) => e.label)).toEqual([
      "Overview",
      "Chat",
      "Orb",
      "Permissions",
      "Audit",
      "Models",
      "Plugins",
      "Devices",
      "Settings",
    ]);
  });

  it("chat and orb are the two external faces of the hub", () => {
    const external = NAV_ENTRIES.filter((e) => e.external);
    expect(external.map((e) => e.href)).toEqual(["/chat", "/orb"]);
  });

  it("every entry has a label, an href, and an external flag", () => {
    for (const e of NAV_ENTRIES) {
      expect(typeof e.label).toBe("string");
      expect(e.label.length).toBeGreaterThan(0);
      expect(typeof e.href).toBe("string");
      expect(e.href.startsWith("/")).toBe(true);
      expect(typeof e.external).toBe("boolean");
    }
  });
});

describe("isActive", () => {
  it("exact-matches the root so Overview is not lit on every page", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/audit", "/")).toBe(false);
  });

  it("prefix-matches everything else so a detail route keeps its section lit", () => {
    expect(isActive("/audit", "/audit")).toBe(true);
    expect(isActive("/audit/entry-1", "/audit")).toBe(true);
    expect(isActive("/models", "/audit")).toBe(false);
  });

  it("marks the orb and chat pages as active on their own paths", () => {
    expect(isActive("/orb", "/orb")).toBe(true);
    expect(isActive("/chat", "/chat")).toBe(true);
  });
});
