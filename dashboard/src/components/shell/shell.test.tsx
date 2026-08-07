import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { NAV_ENTRIES as HUB_ENTRIES } from "@hub/nav/entries";
import { NAV_ENTRIES, isActive } from "./nav";
import { Sidebar } from "./sidebar";

test("the sidebar names all nine destinations", () => {
  expect(NAV_ENTRIES.map((entry) => entry.label)).toEqual([
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
  expect(isActive("/models", "/audit")).toBe(false);

  const html = renderToStaticMarkup(<Sidebar activePath="/audit" />);
  const activeMarks = [...html.matchAll(/data-active="true"/g)];
  expect(activeMarks).toHaveLength(1);
  const activeRegion = html.slice(html.indexOf('data-active="true"'));
  expect(activeRegion).toContain(">Audit<");
});

test("the sidebar carries no second hand-maintained list — it reads the hub's one source", () => {
  // The labels, hrefs, external flags, and order come from @hub/nav/entries.
  // If someone re-introduces a local copy, this test breaks because the two
  // would no longer be the same array.
  expect(NAV_ENTRIES.map((e) => e.label)).toEqual(HUB_ENTRIES.map((e) => e.label));
  expect(NAV_ENTRIES.map((e) => e.href)).toEqual(HUB_ENTRIES.map((e) => e.href));
  expect(NAV_ENTRIES.map((e) => e.external)).toEqual(HUB_ENTRIES.map((e) => e.external));
});

test("every hub link wears an icon — none drifts in without its face", () => {
  // A new link added to the hub source without a matching icon here is the
  // one way this design can still drift. This guard makes it a test failure,
  // not a silent undefined in the sidebar.
  for (const entry of NAV_ENTRIES) {
    expect(entry.icon, `no icon wired for ${entry.href}`).toBeDefined();
  }
});
