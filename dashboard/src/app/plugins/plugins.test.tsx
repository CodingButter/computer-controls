import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { UnreachableNotice } from "@/components/overview/overview";
import { PluginsPanel, admittedPlugins } from "@/components/plugins/plugins";
import { parseHealth } from "@/lib/hub";

/** The hub's real answer, copied from a live GET /api/health. */
const LIVE = {
  ok: true,
  tools: [
    "ask_user",
    "desktop_query_elements",
    "desktop_invoke_element",
    "memory_query",
    "view",
  ],
  desktopScope: "observe",
  plugins: { admitted: ["desktop-control", "memorease"], refused: ["plan"] },
};

test("each admitted plugin is a card carrying the tools it contributed", () => {
  const html = renderToStaticMarkup(<PluginsPanel health={parseHealth(LIVE)} />);

  expect(html).toContain("desktop-control");
  expect(html).toContain("memorease");
  expect(html).toContain("desktop_query_elements");
  expect(html).toContain("memory_query");
  expect(html).toContain("2 admitted · 1 refused");
  // Tools no plugin's name accounts for stay off the page rather than being
  // filed under whichever plugin was listed first.
  expect(html).not.toContain("ask_user");
  expect(html).not.toContain(">view<");
});

test("a refusal the hub did not explain says so rather than disappearing", () => {
  const html = renderToStaticMarkup(<PluginsPanel health={parseHealth(LIVE)} />);

  expect(html).toContain("plan");
  expect(html).toContain("refused, no reason given");
});

test("a refusal that came with a reason shows the hub's own words", () => {
  const health = parseHealth({
    ...LIVE,
    plugins: {
      admitted: LIVE.plugins.admitted,
      refused: [{ name: "handsy", reason: "installed here, but not on the allowlist" }],
    },
  });
  const html = renderToStaticMarkup(<PluginsPanel health={health} />);

  expect(html).toContain("installed here, but not on the allowlist");
  expect(html).not.toContain("no reason given");
});

test("a plugin whose tools cannot be traced is listed with none, never with guesses", () => {
  const health = parseHealth({
    ...LIVE,
    plugins: { admitted: ["plan"], refused: [] },
  });
  const html = renderToStaticMarkup(<PluginsPanel health={health} />);

  expect(html).toContain("plan");
  expect(html).toContain("No tool on this hub traces back to this plugin");
  expect(html).not.toContain("desktop_query_elements");
});

test("a tool two admitted plugins could claim is attributed to neither", () => {
  const census = admittedPlugins(
    ["desktop-control", "desktop"],
    ["desktop_query_elements", "memory_query"],
  );

  // Both plugins answer to "desktop_", so the tool is a tie and neither card
  // claims it — the alternative is a page that files tools under whichever
  // plugin happened to be listed first.
  expect(census).toEqual([
    { name: "desktop-control", tools: [] },
    { name: "desktop", tools: [] },
  ]);
});

test("a hub that answered nothing renders the unreachable notice, not an empty census", () => {
  const html = renderToStaticMarkup(<UnreachableNotice detail="fetch failed" />);

  expect(html).toContain("Hub unreachable");
  expect(html).toContain("fetch failed");
  expect(html).not.toContain("admitted");
});
