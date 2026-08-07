import os from "node:os";
import { describe, expect, it } from "vitest";

import { DEVICES_PATH, buildDevicesApp, type DevicesView } from "./routes.ts";

async function ask(faces: number) {
  const app = buildDevicesApp({ faces: () => faces });
  const response = await app.request(DEVICES_PATH);
  return { response, raw: await response.clone().text(), body: (await response.json()) as DevicesView };
}

describe("what is talking to this hub", () => {
  it("puts this machine first, always, and never offers to remove it", async () => {
    const { response, body } = await ask(0);

    expect(response.status).toBe(200);
    expect(body.devices[0]).toEqual({
      kind: "hub",
      name: "This machine",
      connected: true,
      detail: expect.stringContaining("running here"),
      removable: false,
    });
  });

  it("says plainly that no widget is connected rather than showing a stale row", async () => {
    const { body } = await ask(0);

    const widget = body.devices.find((device) => device.kind === "widget");
    expect(widget?.connected).toBe(false);
    expect(widget?.detail).toContain("No widget is connected");
  });

  it("reports the widget as connected once a face holds the socket", async () => {
    const { body } = await ask(1);

    const widget = body.devices.find((device) => device.kind === "widget");
    expect(widget?.connected).toBe(true);
    expect(widget?.detail).toContain("loopback event socket");
  });

  it("counts every face rather than pretending there is only ever one", async () => {
    const { body } = await ask(2);

    const widget = body.devices.find((device) => device.kind === "widget");
    expect(widget?.detail).toContain("2");
  });

  it("is read per request, so a widget that started after the hub did shows up", async () => {
    // The route holds no snapshot: same app, two answers, because the socket
    // is the source of truth and it changes while the hub is running.
    let faces = 0;
    const app = buildDevicesApp({ faces: () => faces });

    const before = (await (await app.request(DEVICES_PATH)).json()) as DevicesView;
    faces = 1;
    const after = (await (await app.request(DEVICES_PATH)).json()) as DevicesView;

    expect(before.devices.find((d) => d.kind === "widget")?.connected).toBe(false);
    expect(after.devices.find((d) => d.kind === "widget")?.connected).toBe(true);
  });

  it("says why instead of leaving a blank when no pairing store is mounted", async () => {
    const { body } = await ask(0);

    // A hub assembled without a credential store has no registry to read, and
    // an invented row would be worse than an empty list. It reports pairing off
    // with a reason rather than drawing a button that cannot work.
    expect(body.devices.every((device) => device.kind !== "hub" || !device.removable)).toBe(true);
    expect(body.pairing.enabled).toBe(false);
    // Narrowed rather than asserted through: the disabled arm is the only one
    // carrying a reason, and a test that reached for it on the enabled arm
    // would be reading a field the type says is not there.
    if (!body.pairing.enabled) expect(body.pairing.reason).toContain("phone client");
  });

  it("names nothing this product did not generate", async () => {
    // The boundary that makes this page safe to serve: it reports what is
    // connected without becoming the thing that fingerprints the machine. No
    // hostname, no address, no network identifier — not as a field, and not
    // smuggled into a sentence meant for a person.
    const { raw } = await ask(1);

    expect(raw).not.toContain(os.hostname());
    expect(raw).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    expect(raw).not.toMatch(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
    expect(raw).not.toContain(os.userInfo().username);
  });
});
