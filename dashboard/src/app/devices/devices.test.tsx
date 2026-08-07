import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { DevicesPanel } from "@/components/devices/devices";
import { parseDevices } from "@/lib/hub";

/** The hub's real answer, copied from a live GET /api/devices. */
const LIVE = {
  devices: [
    {
      kind: "hub",
      name: "This machine",
      connected: true,
      detail: "The hub is running here. This is the machine the agent acts on.",
      removable: false,
    },
    {
      kind: "widget",
      name: "The orb widget",
      connected: false,
      detail: "No widget is connected to this hub right now. Start it and this row will say so.",
      removable: false,
    },
  ],
  pairing: {
    enabled: false,
    reason:
      "Pairing another device arrives with the phone client. Until then, this hub serves the machine it runs on.",
  },
};

test("every row is the hub's own sentence, connected or not", () => {
  const html = renderToStaticMarkup(<DevicesPanel view={parseDevices(LIVE)} />);

  expect(html).toContain("Devices");
  expect(html).toContain("This machine");
  expect(html).toContain("The orb widget");
  expect(html).toContain("The hub is running here.");
  // A disconnected widget is a row that says so, not a row that vanishes: a
  // page that hid it would answer "what is connected" with a shorter list every
  // time something went wrong.
  expect(html).toContain("Not connected");
  expect(html).toContain("Start it and this row will say so.");
  expect(html).toContain("1 of 2 connected");
});

test("pairing is off with the reason the hub gave, and no button", () => {
  const html = renderToStaticMarkup(<DevicesPanel view={parseDevices(LIVE)} />);

  expect(html).toContain("arrives with the phone client");
  // A control that cannot work is worse than an explanation of why it is
  // absent, so there is nothing to press here at all.
  expect(html).not.toContain("<button");
});

test("nothing on the page names the machine", () => {
  const html = renderToStaticMarkup(<DevicesPanel view={parseDevices(LIVE)} />);

  // The hub mints no hostname, address or MAC, and the page must not become the
  // place one appears. Rendering the live answer produces no dotted quad and no
  // colon-separated hardware address.
  expect(html).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  expect(html).not.toMatch(/\b([0-9a-f]{2}:){5}[0-9a-f]{2}\b/i);
});

test("a row the hub did not fill in properly is dropped, not half-drawn", () => {
  const view = parseDevices({
    devices: [LIVE.devices[0], { kind: "widget" }, null, "widget"],
    pairing: LIVE.pairing,
  });

  expect(view.devices).toHaveLength(1);
  expect(view.devices[0]?.name).toBe("This machine");
});

test("a hub that says nothing about pairing is read as off, never as on", () => {
  // The failure that would matter: a shape this parser does not recognise
  // rendering as "pairing available" and offering a door that is not there.
  const view = parseDevices({ devices: [] });

  expect(view.pairing.enabled).toBe(false);
});

test("a response that is not a devices answer is refused rather than guessed at", () => {
  expect(() => parseDevices({ ok: true })).toThrow();
});

/** The same answer from a hub that has pairing wired and one phone paired to it. */
const PAIRED = {
  devices: [
    LIVE.devices[0],
    LIVE.devices[1],
    {
      kind: "paired",
      name: "Jamie's phone",
      connected: false,
      detail: "Paired with this hub on 2026-08-07.",
      removable: true,
      id: "9f2c41ab77e30d5c",
    },
  ],
  pairing: { enabled: true },
};

test("a paired phone is a row named by what it called itself, and nothing else", () => {
  const html = renderToStaticMarkup(<DevicesPanel view={parseDevices(PAIRED)} onRevoke={() => {}} />);

  expect(html).toContain("Jamie&#x27;s phone");
  expect(html).toContain("Paired with this hub on 2026-08-07.");
  // The label a person typed on their own phone is the whole name. Nothing read
  // off the network joins it here, so the page's own rule still holds with a
  // paired device on the list.
  expect(html).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  expect(html).not.toMatch(/\b([0-9a-f]{2}:){5}[0-9a-f]{2}\b/i);
});

test("only the rows the hub called removable can be removed", () => {
  const view = parseDevices(PAIRED);
  const html = renderToStaticMarkup(<DevicesPanel view={view} onRevoke={() => {}} />);

  // Exactly one Remove control, for exactly the one removable row. This machine
  // and the widget are not things a person revokes, and a page that offered to
  // would be offering an action the hub will refuse.
  expect(html.match(/Remove</g) ?? []).toHaveLength(1);
  expect(view.devices.filter((device) => device.removable)).toHaveLength(1);
});

test("a removable row with no handle gets no control rather than a broken one", () => {
  // The hub omits `id` on rows it will not revoke. If a row claims removable
  // without one, there is nothing to address the request to — so no button.
  const view = parseDevices({
    devices: [{ kind: "paired", name: "A phone", connected: false, detail: "", removable: true }],
    pairing: { enabled: true },
  });
  const html = renderToStaticMarkup(<DevicesPanel view={view} onRevoke={() => {}} />);

  expect(html).not.toContain("Remove<");
});

test("pairing that is on offers the ceremony, and shows no code until asked", () => {
  const html = renderToStaticMarkup(<DevicesPanel view={parseDevices(PAIRED)} />);

  expect(html).toContain("Show a pairing code");
  // The press is the consent. A QR that is simply always on this page is a live
  // credential sitting on a monitor, so nothing is minted at render time.
  expect(html).not.toContain("<svg role=\"img\"");
  expect(html).toContain("lasts two minutes, works once");
});
