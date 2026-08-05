import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import type { Fetched, HubHealth, OrbStatus } from "@/lib/hub";

import { Overview } from "./overview";

const HEALTH: Fetched<HubHealth> = {
  kind: "ok",
  data: {
    ok: true,
    tools: Array.from({ length: 37 }, (_, i) => `tool_${i}`),
    desktopScope: "observe",
    plugins: { admitted: ["desktop-control", "memorease"], refused: ["plan"] },
    model: {
      pack: "computer-controls-anthropic",
      tiers: { minimal: "anthropic/claude-haiku-4-5", heavy: "anthropic/claude-opus-4-6" },
    },
    voice: { enabled: true },
    orb: { enabled: true },
  },
};

const ORB: Fetched<OrbStatus> = {
  kind: "ok",
  data: { enabled: true, state: "listening", gate: "open", languages: [] },
};

test("the cards render the hub's real numbers", () => {
  const html = renderToStaticMarkup(<Overview health={HEALTH} orb={ORB} />);

  expect(html).toContain("Running"); // hub card
  expect(html).toContain("listening"); // orb card carries the live state
  expect(html).toContain("gate: open");
  expect(html).toContain("computer-controls-anthropic"); // model pack by name
  expect(html).toContain("anthropic/claude-opus-4-6"); // tier models listed
  expect(html).toContain("2 admitted"); // plugin census
  expect(html).toContain("1 refused");
  expect(html).toContain(">37<"); // tool count, the number itself
});

test("a refused orb states its reason instead of a fake state", () => {
  const refused: Fetched<OrbStatus> = {
    kind: "ok",
    data: {
      enabled: false,
      reason: "The orb has no realtime voice provider on this machine yet. Typing still works.",
    },
  };
  const html = renderToStaticMarkup(<Overview health={HEALTH} orb={refused} />);
  expect(html).toContain("Typing still works");
  expect(html).not.toContain("gate:");
});

test("an unreachable hub renders the honest fallback, never fake green", () => {
  const html = renderToStaticMarkup(
    <Overview
      health={{ kind: "unreachable", detail: "fetch failed" }}
      orb={{ kind: "unreachable", detail: "fetch failed" }}
    />,
  );
  expect(html).toContain("Hub unreachable");
  expect(html).toContain("fetch failed");
  expect(html).not.toContain("Running");
  expect(html).not.toContain("healthy");
});
