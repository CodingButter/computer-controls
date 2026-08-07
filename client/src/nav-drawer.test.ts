import { describe, expect, it } from "vitest";

// The shipped module, imported exactly as the browser loads it. The DOM-free
// seams are exported on purpose; initNavDrawer is skipped because document is
// undefined here — the same guard orb.js uses.
import { isActiveNav, markActive } from "../public/nav-drawer.js";

type NavEntry = { label: string; href: string; external: boolean; active?: boolean };

const ENTRIES: NavEntry[] = [
  { label: "Overview", href: "/", external: false },
  { label: "Chat", href: "/chat", external: true },
  { label: "Orb", href: "/orb", external: true },
  { label: "Permissions", href: "/permissions", external: false },
  { label: "Audit", href: "/audit", external: false },
  { label: "Settings", href: "/settings", external: false },
];

describe("isActiveNav", () => {
  it("exact-matches the root so Overview is not lit on every page", () => {
    expect(isActiveNav("/", "/")).toBe(true);
    expect(isActiveNav("/audit", "/")).toBe(false);
  });

  it("prefix-matches everything else so a detail route keeps its section lit", () => {
    expect(isActiveNav("/audit", "/audit")).toBe(true);
    expect(isActiveNav("/audit/entry-1", "/audit")).toBe(true);
    expect(isActiveNav("/models", "/audit")).toBe(false);
  });

  it("marks the standalone pages as active on their own paths", () => {
    expect(isActiveNav("/orb", "/orb")).toBe(true);
    expect(isActiveNav("/chat", "/chat")).toBe(true);
  });
});

describe("markActive", () => {
  it("stamps exactly one active entry for a known path", () => {
    const marked: NavEntry[] = markActive(ENTRIES, "/orb");
    const active = marked.filter((e: NavEntry) => e.active);
    expect(active).toHaveLength(1);
    expect(active[0].href).toBe("/orb");
  });

  it("marks Overview active only at the root", () => {
    expect(markActive(ENTRIES, "/").filter((e: NavEntry) => e.active)).toHaveLength(1);
    expect(markActive(ENTRIES, "/").find((e: NavEntry) => e.active)?.href).toBe("/");
    expect(markActive(ENTRIES, "/audit").filter((e: NavEntry) => e.href === "/")[0].active).toBe(false);
  });

  it("preserves every entry's label, href, and external flag", () => {
    const marked: NavEntry[] = markActive(ENTRIES, "/chat");
    expect(marked.map((e: NavEntry) => e.label)).toEqual(ENTRIES.map((e: NavEntry) => e.label));
    expect(marked.map((e: NavEntry) => e.href)).toEqual(ENTRIES.map((e: NavEntry) => e.href));
    expect(marked.map((e: NavEntry) => e.external)).toEqual(ENTRIES.map((e: NavEntry) => e.external));
  });

  it("marks nothing active for a path no entry owns", () => {
    const marked: NavEntry[] = markActive(ENTRIES, "/nonexistent");
    expect(marked.filter((e: NavEntry) => e.active)).toHaveLength(0);
  });
});
