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
  // Permitted state lands on the checkbox itself.
  expect(html).toContain('aria-label="Permit Discord" checked=""');
  expect(html).not.toContain('aria-label="Permit GIMP" checked=""');
  // Running-but-unreadable wears the restart pill; merely installed does not.
  expect(html).toContain("needs restart to become readable");
  expect(html).toContain("not running");
});

test("the new-apps-arrive-unpermitted copy is present", () => {
  const html = renderToStaticMarkup(<PermissionsPanel view={VIEW} onToggle={() => {}} />);
  expect(html).toContain("New applications arrive unpermitted");
});

test("open mode explains the transition the first toggle will make", () => {
  const html = renderToStaticMarkup(
    <PermissionsPanel view={{ ...VIEW, mode: "open" }} onToggle={() => {}} />,
  );
  expect(html).toContain("open — everything permitted");
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
