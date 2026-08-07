import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

import { ConfigRefusedNotice, PermissionsPanel } from "@/components/permissions/permissions";
import { parsePermissions, putAccess, type PermissionsView } from "@/lib/hub";

const VIEW: PermissionsView = {
  mode: "per-application",
  daemon: { reachable: true },
  ceiling: ["observe", "edit", "activate"],
  applications: [
    {
      name: "Discord",
      permitted: true,
      access: "interact",
      running: true,
      readable: true,
      desktopId: "discord.desktop",
    },
    { name: "Google-chrome", permitted: false, access: "off", running: true, readable: false },
    {
      name: "GIMP",
      permitted: false,
      access: "off",
      running: false,
      readable: false,
      desktopId: "gimp.desktop",
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

test("rows render from the merged view with their states", () => {
  const html = renderToStaticMarkup(<PermissionsPanel view={VIEW} onChoose={() => {}} />);

  expect(html).toContain("Discord");
  expect(html).toContain("Google-chrome");
  expect(html).toContain("GIMP");
  // The design's control: one question with three answers, not two flags.
  expect(html).toContain('role="radiogroup"');
  expect(html).toContain('aria-label="Access for Discord"');
  expect(html).toContain("View only");
  expect(html).toContain("Interact");
  // Pills per the design: an unpermitted app wears its pill, and a permitted
  // app the accessibility layer cannot read wears the cure-and-restart warning.
  expect(html).toContain("Not permitted");
  const cureWarned = renderToStaticMarkup(
    <PermissionsPanel
      view={{
        ...VIEW,
        applications: [
          {
            name: "Google-chrome",
            permitted: true,
            access: "interact",
            running: true,
            readable: false,
          },
        ],
      }}
      onChoose={() => {}}
    />,
  );
  expect(cureWarned).toContain("Needs accessibility cure");
});

test("the panel stamps how old the census on screen is", () => {
  const fresh = renderToStaticMarkup(
    <PermissionsPanel view={VIEW} onChoose={() => {}} updatedAt={0} now={12_000} />,
  );
  expect(fresh).toContain("Updated 12s ago");

  // Past a minute the stamp rolls over rather than counting seconds forever.
  const older = renderToStaticMarkup(
    <PermissionsPanel view={VIEW} onChoose={() => {}} updatedAt={0} now={120_000} />,
  );
  expect(older).toContain("Updated 2m ago");
});

test("the refresh affordance and the stamp are only drawn for a caller that has a clock", () => {
  const withRefresh = renderToStaticMarkup(
    <PermissionsPanel view={VIEW} onChoose={() => {}} updatedAt={0} now={0} onRefresh={() => {}} />,
  );
  expect(withRefresh).toContain("Refresh");

  // A caller with neither promises neither: no stamp claiming a freshness it
  // cannot know, and no button wired to nothing.
  const bare = renderToStaticMarkup(<PermissionsPanel view={VIEW} onChoose={() => {}} />);
  expect(bare).not.toContain("Updated");
  expect(bare).not.toContain("Refresh");
});

test("the chosen state is the one the control marks, and the three read in the order they widen", () => {
  const html = renderToStaticMarkup(
    <PermissionsPanel
      view={{
        ...VIEW,
        applications: [
          {
            name: "Discord",
            permitted: true,
            access: "view",
            classes: ["observe"],
            running: true,
            readable: true,
          },
        ],
      }}
      onChoose={() => {}}
    />,
  );

  // Exactly one radio is checked, and it is the one the row is in.
  const checked = html.match(/aria-checked="true"[^>]*>([^<]*)</g) ?? [];
  expect(checked).toHaveLength(2); // the row control and the detail panel's, same state
  expect(checked.every((segment) => segment.endsWith(">View only<"))).toBe(true);
  // View-only is a permitted state, and says so rather than reading as "off".
  expect(html).toContain("View only");
});

test("interact spells out that viewing comes with it", () => {
  const html = renderToStaticMarkup(<PermissionsPanel view={VIEW} onChoose={() => {}} />);
  expect(html).toContain("Interacting includes viewing");
});

test("a config this page cannot express is shown as itself, not rounded to a neighbour", () => {
  const html = renderToStaticMarkup(
    <PermissionsPanel
      view={{
        ...VIEW,
        applications: [
          {
            name: "Discord",
            permitted: true,
            access: "custom",
            classes: ["observe", "submit"],
            running: true,
            readable: true,
          },
        ],
      }}
      onChoose={() => {}}
    />,
  );

  expect(html).toContain("Set by hand in the config file to observe, submit");
  // No button claims to be the state, because none of them is.
  expect(html).not.toContain('aria-checked="true"');
});

test("the design chrome is present: heading, mode control, search, banner, detail panel", () => {
  const html = renderToStaticMarkup(<PermissionsPanel view={VIEW} onChoose={() => {}} />);
  expect(html).toContain("Application Permissions");
  expect(html).toContain("Per-application");
  expect(html).toContain('aria-label="Search applications"');
  expect(html).toContain("New applications arrive unpermitted");
  expect(html).toContain("Nothing an agent does can widen this list");
  // The detail panel opens on the first running row by default — Discord —
  // showing real facts, not invented ones.
  expect(html).toContain("On the accessibility bus");
  // Rows with a launcher entry ask the hub for the real icon; rows without
  // one fall back to the initial avatar.
  expect(html).toContain('src="/api/permissions/icon/discord.desktop"');
});

test("open mode explains the transition the first choice will make", () => {
  const html = renderToStaticMarkup(
    <PermissionsPanel view={{ ...VIEW, mode: "open" }} onChoose={() => {}} />,
  );
  expect(html).toContain("open mode");
  expect(html).toContain("per-application mode");
});

test("an unreachable daemon renders the honest notice, rows still present", () => {
  const html = renderToStaticMarkup(
    <PermissionsPanel
      view={{ ...VIEW, daemon: { reachable: false, reason: "not running." } }}
      onChoose={() => {}}
    />,
  );
  expect(html).toContain("The desktop service is not running");
  expect(html).toContain("GIMP");
});

test("a refused config renders the reason and promises not to overwrite", () => {
  const html = renderToStaticMarkup(<ConfigRefusedNotice detail="unknown permissionsMode" />);
  expect(html).toContain("unknown permissionsMode");
  expect(html).toContain("ever overwrite a config it cannot read");
});

test("choosing a state fires a PUT with the exact name and the state chosen", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ mode: "per-application", daemon: { reachable: true }, applications: [] }),
  }));
  vi.stubGlobal("fetch", fetchMock);

  await putAccess("Google-chrome", "view");

  expect(fetchMock).toHaveBeenCalledWith("/api/permissions/Google-chrome", {
    method: "PUT",
    body: JSON.stringify({ access: "view" }),
    headers: { "content-type": "application/json" },
  });
});

test("parsePermissions is honest about shapes it does not recognise", () => {
  expect(() => parsePermissions({ nope: true })).toThrow();
  const view = parsePermissions({
    mode: "per-application",
    daemon: { reachable: false, reason: "gone" },
    applications: [
      { name: "Discord", permitted: true, access: "view", classes: ["observe"], running: true, readable: true },
      { bad: 1 },
    ],
  });
  expect(view.applications).toHaveLength(1);
  expect(view.applications[0].access).toBe("view");
  expect(view.applications[0].classes).toEqual(["observe"]);
  expect(view.daemon).toEqual({ reachable: false, reason: "gone" });
});

test("a row from a hub that does not speak access still reads as its flag", () => {
  const view = parsePermissions({
    mode: "per-application",
    daemon: { reachable: true },
    applications: [
      { name: "Discord", permitted: true, running: true, readable: true },
      { name: "GIMP", permitted: false, running: false, readable: false },
    ],
  });
  expect(view.applications.map((row) => row.access)).toEqual(["interact", "off"]);
});

test("an observe-only desktop cannot offer interaction, and says why", () => {
  // The daemon's default: no operationClasses at all is observe alone. Offering
  // "Interact" here would offer a write that lands in the file and changes
  // nothing the daemon does.
  const html = renderToStaticMarkup(
    <PermissionsPanel
      view={{
        ...VIEW,
        ceiling: ["observe"],
        applications: [
          {
            name: "Discord",
            permitted: true,
            access: "view",
            classes: ["observe"],
            running: true,
            readable: true,
          },
        ],
      }}
      onChoose={() => {}}
    />,
  );

  expect(html).toContain("operation classes stop at observe");
  expect(html).toContain("scopes.operationClasses");
  // The Interact button specifically, and only it, is refused.
  const buttons = html.split("<button").filter((piece) => piece.includes("</button>"));
  const interact = buttons.find((piece) => piece.includes(">Interact<"));
  expect(interact).toContain("disabled=\"\"");
  expect(buttons.find((piece) => piece.includes(">View only<"))).not.toContain("disabled=\"\"");

  // And a desktop that can interact wears neither the notice nor the refusal.
  const wider = renderToStaticMarkup(<PermissionsPanel view={VIEW} onChoose={() => {}} />);
  expect(wider).not.toContain("operation classes stop at observe");
  expect(wider).not.toContain("disabled=\"\"");
});

test("a hub that does not report a ceiling is read as the daemon's default", () => {
  const view = parsePermissions({
    mode: "per-application",
    daemon: { reachable: true },
    applications: [],
  });
  expect(view.ceiling).toEqual(["observe"]);
});
