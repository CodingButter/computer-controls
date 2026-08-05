import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

import {
  DEPTHS,
  FIELDS,
  SettingsPanel,
  SettingsRefusedNotice,
  fieldsAtDepth,
  readSetting,
  undrawnKeys,
  type Depth,
} from "@/components/settings/settings";
import {
  parseAutostart,
  parseDesktopConfig,
  putAutostart,
  putDesktopSettings,
  type DesktopConfigView,
} from "@/lib/hub";

/**
 * A configuration with something at every depth, two keys the Permissions page
 * owns, and one key no version of this page has ever heard of.
 */
const CONFIG = {
  scopes: {
    permissionsMode: "per-application",
    operationClasses: ["observe", "edit"],
    confirmClasses: ["submit", "destructive"],
    idleExpirySeconds: 900,
    applications: ["Discord"],
    blockedApplications: ["bitwarden", "keepassxc"],
    somethingFromNextYear: { nested: true },
  },
  sensitiveApplications: ["bitwarden"],
  audit: true,
  auditPath: "/home/someone/.local/state/audit.jsonl",
  aKeyNobodyHasTaughtThisPageAbout: 42,
};

const VIEW: DesktopConfigView = {
  config: CONFIG,
  exists: true,
  path: "/home/someone/.config/mastracode-desktop/config.json",
  owns: [
    "scopes.permissionsMode",
    "scopes.operationClasses",
    "scopes.confirmClasses",
    "scopes.idleExpirySeconds",
    "sensitiveApplications",
    "audit",
    "auditPath",
  ],
  defaults: {
    permissionsMode: "open",
    operationClasses: ["observe"],
    confirmClasses: ["submit", "destructive"],
    idleExpirySeconds: 1800,
    audit: true,
  },
  vocabulary: {
    permissionsModes: ["open", "per-application"],
    operationClasses: ["observe", "edit", "activate", "submit", "destructive"],
  },
};

/** The hub's real answer shape from GET /api/autostart on a freedesktop machine. */
const ON = {
  supported: true,
  enabled: true,
  path: "/home/jamie/.config/autostart/mastra-cc-widget.desktop",
};

const UNSUPPORTED = {
  supported: false,
  reason: "Start on boot is not supported on macos yet.",
};

function draw(
  depth: Depth,
  view: DesktopConfigView = VIEW,
  over: Partial<Parameters<typeof SettingsPanel>[0]> = {},
) {
  return renderToStaticMarkup(
    <SettingsPanel
      view={view}
      depth={depth}
      onDepth={() => {}}
      onSave={() => {}}
      autostart={parseAutostart(ON)}
      autostartBusy={false}
      onFlipAutostart={() => {}}
      {...over}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("every depth is a filter over one field list, never a form of its own", () => {
  // The ruling, as an assertion: a deeper lens draws everything a shallower one
  // draws. If a field were ever added to Standard only, this fails — which is
  // the moment the three depths would have begun disagreeing.
  const easy = fieldsAtDepth("easy").map((f) => f.key);
  const standard = fieldsAtDepth("standard").map((f) => f.key);
  const advanced = fieldsAtDepth("advanced").map((f) => f.key);

  expect(standard.slice(0, easy.length)).toEqual(easy);
  expect(advanced.slice(0, standard.length)).toEqual(standard);
  expect(advanced).toEqual(FIELDS.map((f) => f.key));
  expect(easy.length).toBeLessThan(standard.length);
  expect(standard.length).toBeLessThan(advanced.length);
});

test("no lens can draw a field the write path does not own", () => {
  // A control the route would refuse is a control that accepts a click, reports
  // nothing, and changes nothing. The one place that could happen is a typo in
  // a field key, so the keys are checked against the route's own `owns` list.
  for (const field of FIELDS) {
    expect(VIEW.owns).toContain(field.key);
  }
});

test("Easy draws the permissions mode and the faces, and stops there", () => {
  const html = draw("easy");
  expect(html).toContain("Which applications an agent may touch");
  expect(html).toContain("Voice and orb");
  // Standard's fields are absent from the view, not disabled in it.
  expect(html).not.toContain("How long a grant survives");
  expect(html).not.toContain("Where the audit log is written");
  // And it links to the page that owns the per-application list rather than
  // growing a second one.
  expect(html).toContain('href="/permissions"');
});

test("Standard adds what an agent may do, what it must ask about, and for how long", () => {
  const html = draw("standard");
  expect(html).toContain("Which applications an agent may touch");
  expect(html).toContain("What an agent may do");
  expect(html).toContain("What it must ask you about first");
  expect(html).toContain("How long a grant survives");
  expect(html).not.toContain("Applications whose contents are redacted");
});

test("Advanced draws every field, the file's path, and the keys it does not own", () => {
  const html = draw("advanced");
  for (const field of FIELDS) expect(html).toContain(field.label);
  expect(html).toContain("/home/someone/.config/mastracode-desktop/config.json");
  // The honest half of "shows the whole object": keys this build never heard of
  // are shown, named as not ours, and left alone.
  expect(html).toContain("scopes.applications");
  expect(html).toContain("the Permissions page owns this");
  expect(html).toContain("scopes.somethingFromNextYear");
  expect(html).toContain("aKeyNobodyHasTaughtThisPageAbout");
});

test("values are drawn from the file, and unset values show the daemon's default", () => {
  const html = draw("standard");
  // 900 seconds is drawn as 15 minutes, from the file.
  expect(html).toMatch(/value="15"/);

  const empty = draw("standard", { ...VIEW, config: {}, exists: false });
  // Unset is not an empty box: it is 30 minutes, marked as the daemon's.
  expect(empty).toMatch(/value="30"/);
  expect(empty).toContain("Daemon default");
  // And the mode select falls back to the daemon's own default rather than the
  // first option that happened to be listed.
  expect(empty).toContain("Open mode permits every application");
});

test("walking Easy to Advanced and back changes what is shown, never what is stored", () => {
  // The acceptance rule from docs/10-distribution-and-dashboard.md, executed
  // literally: configure at one depth, switch to another and back, and diff the
  // configuration object.
  const seen: string[] = [];
  const walk: readonly Depth[] = ["easy", "standard", "advanced", "standard", "easy"];
  const before = JSON.stringify(CONFIG);

  for (const depth of walk) seen.push(draw(depth));

  expect(JSON.stringify(CONFIG)).toBe(before);
  // Same object, genuinely different views of it, and the return trip is
  // identical to the outbound one.
  expect(seen[0]).toBe(seen[4]);
  expect(seen[1]).toBe(seen[3]);
  expect(seen[0]).not.toBe(seen[2]);
});

test("a save sends one leaf key, never the document", async () => {
  // The losslessness guarantee at this end. A page that PUTs the object it
  // rendered deletes every key it did not render.
  let body: string | undefined;
  const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
    body = init?.body as string;
    return {
      ok: true,
      status: 200,
      json: async () => ({ config: CONFIG, exists: true, path: "/tmp/c.json", owns: [] }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);

  await putDesktopSettings({ "scopes.idleExpirySeconds": 600 });

  expect(fetchMock).toHaveBeenCalledWith("/api/desktop-config", {
    method: "PUT",
    body: JSON.stringify({ edits: { "scopes.idleExpirySeconds": 600 } }),
    headers: { "content-type": "application/json" },
  });
  const sent = JSON.parse(body ?? "{}");
  expect(Object.keys(sent.edits)).toHaveLength(1);
  expect(sent.edits).not.toHaveProperty("scopes");
});

test("a refusal is shown verbatim and promises the file was not touched", () => {
  const html = renderToStaticMarkup(
    <SettingsRefusedNotice detail="idleExpirySeconds must be a non-negative number" />,
  );
  expect(html).toContain("idleExpirySeconds must be a non-negative number");
  expect(html).toContain("Nothing was written");
});

test("a 400 and a 409 both read as refusals, not as unreachable", async () => {
  for (const status of [400, 409]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status,
        json: async () => ({ error: "a reason worth reading" }),
      })),
    );
    await expect(putDesktopSettings({ audit: false })).resolves.toEqual({
      kind: "refused",
      detail: "a reason worth reading",
    });
  }
});

test("readSetting and undrawnKeys do not assume the branches exist", () => {
  expect(readSetting({}, "scopes.permissionsMode")).toBeUndefined();
  expect(readSetting({ scopes: "broken" }, "scopes.permissionsMode")).toBeUndefined();
  expect(readSetting(CONFIG, "scopes.idleExpirySeconds")).toBe(900);
  expect(readSetting(CONFIG, "audit")).toBe(true);

  expect(undrawnKeys({})).toEqual([]);
  // Everything a field draws is absent from the list; everything else is in it.
  const undrawn = undrawnKeys(CONFIG);
  for (const field of FIELDS) expect(undrawn).not.toContain(field.key);
  expect(undrawn).toContain("scopes.applications");
});

test("parseDesktopConfig is honest about shapes it does not recognise", () => {
  expect(() => parseDesktopConfig({ nope: true })).toThrow();
  const view = parseDesktopConfig({
    config: { audit: false },
    exists: true,
    path: "/tmp/c.json",
    owns: ["audit", 7],
    defaults: {},
    vocabulary: { operationClasses: ["observe"] },
  });
  expect(view.owns).toEqual(["audit"]);
  // Missing defaults fall back to the daemon's, never to zero or empty — a lens
  // drawing "0 minutes" for an unreported default would be inventing a policy.
  expect(view.defaults.idleExpirySeconds).toBe(1800);
  expect(view.defaults.permissionsMode).toBe("open");
  expect(view.vocabulary.permissionsModes).toEqual(["open", "per-application"]);
});

test("the depth vocabulary is exactly the three the ruling names", () => {
  expect([...DEPTHS]).toEqual(["easy", "standard", "advanced"]);
});

/**
 * Start on boot is a control on this page that is not a field in the file.
 * These are main's autostart tests, kept: the lenses arrived beside the switch
 * rather than in place of it.
 */

test("the switch draws the hub's truth and names the file it edits", () => {
  const html = draw("easy");
  expect(html).toContain("Start on boot");
  expect(html).toContain('aria-checked="true"');
  // The person's own file, named — this page edits it, so it says which one.
  expect(html).toContain("mastra-cc-widget.desktop");
});

test("a disabled entry draws as off, not as a missing card", () => {
  const html = draw("easy", VIEW, { autostart: parseAutostart({ ...ON, enabled: false }) });
  expect(html).toContain('aria-checked="false"');
});

test("start on boot is drawn at every depth, and is never one of the file's fields", () => {
  // It edits the desktop's autostart entry, not the configuration object, so it
  // belongs to no lens — and Advanced, which lists everything in the file,
  // must not claim it as a key.
  for (const depth of DEPTHS) expect(draw(depth)).toContain("Start on boot");
  for (const field of FIELDS) expect(field.key).not.toContain("autostart");
  expect(draw("advanced")).not.toContain("autostart:");
});

test("a refused save is the hub's sentence verbatim, beside the switch", () => {
  const html = draw("easy", VIEW, {
    autostartRefusal: "Start on boot is not supported on macos yet.",
  });
  expect(html).toContain("Start on boot is not supported on macos yet.");
  // The switch stays drawn with what the hub still holds: a refusal is a
  // sentence beside the control, never a page that gives up.
  expect(html).toContain('role="switch"');
});

test("an unsupported hub is a reason, never a dead switch", () => {
  const html = draw("easy", VIEW, { autostart: parseAutostart(UNSUPPORTED) });
  expect(html).toContain("not supported on macos");
  expect(html).not.toContain('aria-label="Start the widget on boot"');
});

test("a hub silent about autostart says so, rather than drawing a switch it cannot back", () => {
  // The configuration route answered and the lenses are drawn; only the login
  // entry is unknown. A switch here would not know what it was changing.
  const html = draw("easy", VIEW, { autostart: undefined });
  expect(html).toContain("Which applications an agent may touch");
  expect(html).toContain("Not reported");
  expect(html).not.toContain('aria-label="Start the widget on boot"');
});

test("a hub that answers gibberish is refused rather than guessed at", () => {
  expect(() => parseAutostart({ ok: true })).toThrow();
  // A supported answer without a path is not a supported answer.
  expect(() => parseAutostart({ supported: true, enabled: true })).toThrow();
  // An unsupported answer with no sentence still reads as off, with a fallback.
  const view = parseAutostart({ supported: false });
  expect(view.supported).toBe(false);
});

test("the write sends exactly the boolean and returns the hub's fresh read", async () => {
  const calls: unknown[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true, json: async () => ({ ...ON, enabled: false }) };
    }),
  );

  const saved = await putAutostart(false);
  expect(calls[0]?.[0]).toBe("/api/autostart");
  expect(calls[0]?.[1]).toMatchObject({ method: "PUT", body: JSON.stringify({ enabled: false }) });
  expect(saved).toEqual({ ...ON, enabled: false });
});

test("a refused write throws the hub's sentence, not a decorated status code", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: "Start on boot is not supported on macos yet." }),
    })),
  );

  await expect(putAutostart(true)).rejects.toThrow("Start on boot is not supported on macos yet.");
});
