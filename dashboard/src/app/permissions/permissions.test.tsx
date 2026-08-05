import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

import { ConfigRefusedNotice, PermissionsPanel } from "@/components/permissions/permissions";
import { parsePermissions, putPermission, type PermissionsView } from "@/lib/hub";

const VIEW: PermissionsView = {
  mode: "per-application",
  daemon: { reachable: true },
  applications: [
    { name: "Discord", permitted: true, running: true, readable: true, desktopId: "discord.desktop" },
    { name: "Google-chrome", permitted: false, running: true, readable: false },
    { name: "GIMP", permitted: false, running: false, readable: false, desktopId: "gimp.desktop" },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

test("rows render from the merged view with their states", () => {
  const html = renderToStaticMarkup(<PermissionsPanel view={VIEW} onToggle={() => {}} />);

  expect(html).toContain("Discord");
  expect(html).toContain("Google-chrome");
  expect(html).toContain("GIMP");
  // Permitted state lands on the switch itself, the design's control.
  expect(html).toContain('role="switch"');
  expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Permit Discord"/);
  expect(html).toMatch(/aria-checked="false"[^>]*aria-label="Permit GIMP"/);
  // Pills per the design: permitted wears its pill, and a permitted app the
  // accessibility layer cannot read wears the cure-and-restart warning.
  expect(html).toContain("Permitted");
  expect(html).toContain("Not permitted");
  const cureWarned = renderToStaticMarkup(
    <PermissionsPanel
      view={{
        ...VIEW,
        applications: [
          { name: "Google-chrome", permitted: true, running: true, readable: false },
        ],
      }}
      onToggle={() => {}}
    />,
  );
  expect(cureWarned).toContain("Needs accessibility cure");
});

test("the design chrome is present: heading, mode control, search, banner, detail panel", () => {
  const html = renderToStaticMarkup(<PermissionsPanel view={VIEW} onToggle={() => {}} />);
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

test("open mode explains the transition the first toggle will make", () => {
  const html = renderToStaticMarkup(
    <PermissionsPanel view={{ ...VIEW, mode: "open" }} onToggle={() => {}} />,
  );
  expect(html).toContain("open mode");
  expect(html).toContain("per-application mode");
});

test("an unreachable daemon renders the honest notice, rows still present", () => {
  const html = renderToStaticMarkup(
    <PermissionsPanel
      view={{ ...VIEW, daemon: { reachable: false, reason: "not running." } }}
      onToggle={() => {}}
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

test("the toggle fires a PUT with the exact name and the boolean", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ mode: "per-application", daemon: { reachable: true }, applications: [] }),
  }));
  vi.stubGlobal("fetch", fetchMock);

  await putPermission("Google-chrome", true);

  expect(fetchMock).toHaveBeenCalledWith("/api/permissions/Google-chrome", {
    method: "PUT",
    body: JSON.stringify({ permitted: true }),
    headers: { "content-type": "application/json" },
  });
});

test("parsePermissions is honest about shapes it does not recognise", () => {
  expect(() => parsePermissions({ nope: true })).toThrow();
  const view = parsePermissions({
    mode: "per-application",
    daemon: { reachable: false, reason: "gone" },
    applications: [{ name: "Discord", permitted: true, running: true, readable: true }, { bad: 1 }],
  });
  expect(view.applications).toHaveLength(1);
  expect(view.daemon).toEqual({ reachable: false, reason: "gone" });
});
