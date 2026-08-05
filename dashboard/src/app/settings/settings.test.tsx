import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { SettingsPanel } from "@/components/settings/settings";
import { parseAutostart, putAutostart } from "@/lib/hub";

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

const panel = (over: Partial<Parameters<typeof SettingsPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <SettingsPanel
      autostart={parseAutostart(ON)}
      autostartBusy={false}
      onFlipAutostart={() => {}}
      {...over}
    />,
  );

test("the switch draws the hub's truth and names the file it edits", () => {
  const html = panel();
  expect(html).toContain("Start on boot");
  expect(html).toContain('aria-checked="true"');
  // The person's own file, named — this page edits it, so it says which one.
  expect(html).toContain("mastra-cc-widget.desktop");
});

test("a disabled entry draws as off, not as a missing card", () => {
  const html = panel({ autostart: parseAutostart({ ...ON, enabled: false }) });
  expect(html).toContain('aria-checked="false"');
});

test("a refused save is the hub's sentence verbatim, beside the switch", () => {
  const html = panel({ autostartRefusal: "Start on boot is not supported on macos yet." });
  expect(html).toContain("Start on boot is not supported on macos yet.");
  // The switch stays drawn with what the hub still holds: a refusal is a
  // sentence beside the control, never a page that gives up.
  expect(html).toContain('role="switch"');
});

test("an unsupported hub is a reason, never a dead switch", () => {
  const html = panel({ autostart: parseAutostart(UNSUPPORTED) });
  expect(html).toContain("not supported on macos");
  expect(html).not.toContain('role="switch"');
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
  vi.unstubAllGlobals();
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

  await expect(putAutostart(true)).rejects.toThrow(
    "Start on boot is not supported on macos yet.",
  );
  vi.unstubAllGlobals();
});
