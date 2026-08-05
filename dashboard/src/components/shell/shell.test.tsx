import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { NAV_ENTRIES, isActive } from "./nav";
import { Sidebar } from "./sidebar";

test("the sidebar names all nine destinations", () => {
  expect(NAV_ENTRIES.map((entry) => entry.label)).toEqual([
    "Overview",
    "Chat",
    "Orb",
    "Permissions",
    "Audit",
    "Accounts",
    "Plugins",
    "Devices",
    "Settings",
  ]);

  const html = renderToStaticMarkup(<Sidebar activePath="/" />);
  for (const entry of NAV_ENTRIES) {
    expect(html).toContain(`>${entry.label}<`);
  }
});

test("chat and orb are links out of the app, not routes of it", () => {
  // The hub serves chat and the orb from its own static root; the dashboard
  // links to them and must never try to own them.
  const external = NAV_ENTRIES.filter((entry) => entry.external);
  expect(external.map((entry) => entry.href)).toEqual(["/chat", "/orb"]);

  const html = renderToStaticMarkup(<Sidebar activePath="/" />);
  expect(html).toContain('href="/chat"');
  expect(html).toContain('href="/orb"');
});

test("the visitor's page gets the pill and only that page", () => {
  // The root is exact-match — "/" prefixes everything, and an Overview pill
  // that never went out would be wrong on all eight other pages.
  expect(isActive("/", "/")).toBe(true);
  expect(isActive("/audit", "/")).toBe(false);
  expect(isActive("/audit", "/audit")).toBe(true);
  expect(isActive("/audit/entry-1", "/audit")).toBe(true);
  expect(isActive("/accounts", "/audit")).toBe(false);

  const html = renderToStaticMarkup(<Sidebar activePath="/audit" />);
  const activeMarks = [...html.matchAll(/data-active="true"/g)];
  expect(activeMarks).toHaveLength(1);
  const activeRegion = html.slice(html.indexOf('data-active="true"'));
  expect(activeRegion).toContain(">Audit<");
});
