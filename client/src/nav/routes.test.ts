import { describe, expect, it } from "vitest";

import { NAV_ENTRIES } from "./entries.ts";
import { buildNavApp } from "./routes.ts";

describe("GET /api/nav", () => {
  it("serves the hub's nav entries as data", async () => {
    const res = await buildNavApp().request("/api/nav");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: NAV_ENTRIES });
  });

  it("every entry carries a label, href, and external flag — no more", async () => {
    const res = await buildNavApp().request("/api/nav");
    const body = await res.json();

    for (const entry of body.entries) {
      expect(Object.keys(entry).sort()).toEqual(["external", "href", "label"]);
    }
  });

  it("contains exactly the two external hrefs the standalone pages need", async () => {
    const res = await buildNavApp().request("/api/nav");
    const body = await res.json();
    const external = body.entries.filter((e: { external: boolean }) => e.external);

    expect(external.map((e: { href: string }) => e.href)).toEqual(["/chat", "/orb"]);
  });
});
